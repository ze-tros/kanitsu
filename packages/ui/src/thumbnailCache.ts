import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';

/**
 * 缩略图请求优先级（与主进程多级优先级队列对齐，见 apps/desktop/electron/main.ts）：
 * 0 可见 > 1 滚动方向预取 > 2 当前目录 > 3 子文件夹/封面 > 4 全库预热。
 */
export const THUMB_PRIORITY_VISIBLE = 0;
export const THUMB_PRIORITY_DIRECTIONAL = 1;
export const THUMB_PRIORITY_CURRENT_DIR = 2;
export const THUMB_PRIORITY_SUBFOLDER = 3;
export const THUMB_PRIORITY_WARMUP = 4;
export const DEFAULT_THUMBNAIL_SIZE = 512;
export const COVER_THUMBNAIL_SIZE = 1024;

/**
 * 会话级缩略图内存缓存（LRU）。
 *
 * BlobImage 在每次挂载时都会重新读取缩略图；切换文件夹再切回时，组件卸载并
 * 撤销了 object URL，重新挂载又走一遍 readThumbnail（Electron 下是 IPC +
 * 主进程磁盘解码 + 缩放 + JPEG 编码，很慢）。这里把已生成的缩略图 Blob 缓存
 * 起来，切回时直接复用：只新建一个 object URL，不再触发任何解码或 IPC。
 *
 * 键包含文件的 mtime/size，文件被覆盖或重命名后键自动变化，无需手动失效。
 * 缓存 Promise 以合并同文件夹下并发的挂载请求（同一文件的多次读取只发一次）。
 */
interface ThumbEntry {
  /** 已解析出的 Blob；未决时为 null。 */
  blob: Blob | null;
  /** 已解析出的 Blob 字节数；未决时为 0。 */
  bytes: number;
  /** 创建该条目时的缓存代次，防止 clear 前的请求回填。 */
  generation: number;
  /** 上次被“可见请求升级”的时间戳：防止窗口反复进货时对同一文件狂发 IPC。 */
  lastPromotedAt?: number;
  job: ReadJob | null;
}

interface Consumer {
  shouldCancel?: () => boolean;
  resolve: (blob: Blob) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

interface ReadJob {
  entry: ThumbEntry;
  key: string;
  store: LibraryStore;
  file: FileRef;
  maxSize: number;
  priority: number;
  state: 'queued' | 'running' | 'settled';
  queueVersion: number;
  consumers: Set<Consumer>;
}

const MAX_BYTES = 256 * 1024 * 1024; // 256MB：512px 缩略图约 7–30KB/张，容量封顶即可
/**
 * 单条 Blob 上限。512px 缩略图通常只有数十 KB；4MB 上限仅作异常输出兜底，
 * 再由 256MB 总容量 LRU 控制会话内存。
 */
const MAX_SINGLE_BLOB_BYTES = 4 * 1024 * 1024;

// Map 迭代序即 LRU 序（最久未用在前）。
const entries = new Map<string, ThumbEntry>();
let totalBytes = 0;
let cacheGeneration = 0;

// —— 全局并发上限 ——
// 无论可见卡片 + 各级预取（当前目录/子文件夹/全库预热/滚动方向）同时触发多少
// 个 readThumbnail，真正打到原生层的并发读取数不超过 MAX_CONCURRENT_READS。
// Android 原生侧无优先级队列、无界线程池，每个请求会立刻被拉起来解码；这里在
// 源头把洪峰收口成常量，避免快速滚动时几十上百张同时解码打爆堆（OOM 闪退）。
// 同键请求仍由上面的 Promise 缓存合并；这是不同键之间的全局限流。
const MAX_CONCURRENT_READS = 3;
// 非可见任务最多占两个槽，始终给刚进入视口的缩略图留一个可立即启动的槽位。
const MAX_CONCURRENT_NON_VISIBLE_READS = MAX_CONCURRENT_READS - 1;
let inFlightReads = 0;
let inFlightNonVisibleReads = 0;
let backgroundReadsPaused = false;

class ThumbnailReadCancelledError extends Error {
  constructor() {
    super('缩略图预取已取消');
    this.name = 'ThumbnailReadCancelledError';
  }
}

interface QueuedRead {
  job: ReadJob;
  version: number;
}

const readQueues: QueuedRead[][] = Array.from(
  { length: THUMB_PRIORITY_WARMUP + 1 },
  () => [],
);

function normalizePriority(priority: number | undefined): number {
  return Math.max(
    THUMB_PRIORITY_VISIBLE,
    Math.min(THUMB_PRIORITY_WARMUP, priority ?? THUMB_PRIORITY_VISIBLE),
  );
}

function rejectConsumer(consumer: Consumer, error: unknown): void {
  if (consumer.settled) return;
  consumer.settled = true;
  consumer.reject(error);
}

function resolveConsumer(consumer: Consumer, blob: Blob): void {
  if (consumer.settled) return;
  consumer.settled = true;
  consumer.resolve(blob);
}

function enqueueJob(job: ReadJob): void {
  job.queueVersion++;
  readQueues[job.priority]!.push({ job, version: job.queueVersion });
}

function takeNextRead(): QueuedRead | null {
  for (let priority = THUMB_PRIORITY_VISIBLE; priority <= THUMB_PRIORITY_WARMUP; priority++) {
    if (
      priority > THUMB_PRIORITY_VISIBLE &&
      inFlightNonVisibleReads >= MAX_CONCURRENT_NON_VISIBLE_READS
    ) continue;
    if (backgroundReadsPaused && priority >= THUMB_PRIORITY_CURRENT_DIR) continue;
    const queue = readQueues[priority]!;
    while (queue.length > 0) {
      const next = queue.shift()!;
      const { job } = next;
      if (job.state !== 'queued' || job.queueVersion !== next.version || job.priority !== priority) continue;
      for (const consumer of job.consumers) {
        if (consumer.shouldCancel?.()) rejectConsumer(consumer, new ThumbnailReadCancelledError());
      }
      for (const consumer of job.consumers) {
        if (consumer.settled) job.consumers.delete(consumer);
      }
      if (job.consumers.size === 0) {
        job.state = 'settled';
        if (job.entry.job === job) job.entry.job = null;
        continue;
      }
      return next;
    }
  }
  return null;
}

function pumpReadQueue(): void {
  while (inFlightReads < MAX_CONCURRENT_READS) {
    const next = takeNextRead();
    if (!next) return;
    const { job } = next;
    inFlightReads++;
    if (job.priority > THUMB_PRIORITY_VISIBLE) inFlightNonVisibleReads++;
    startReadJob(job);
  }
}

function finishReadJob(job: ReadJob): void {
  inFlightReads--;
  if (job.priority > THUMB_PRIORITY_VISIBLE) inFlightNonVisibleReads--;
  pumpReadQueue();
}

function startReadJob(job: ReadJob): void {
  job.state = 'running';
  Promise.resolve()
    .then(() => job.store.readThumbnail(job.file, job.maxSize, { priority: job.priority }))
    .then(
      (blob) => {
        const entry = job.entry;
        if (entry.generation !== cacheGeneration) {
          for (const consumer of job.consumers) resolveConsumer(consumer, blob);
          return;
        }
        if (entry.blob === null) {
          entry.blob = blob;
          if (blob.size <= MAX_SINGLE_BLOB_BYTES && entries.get(job.key) === entry) {
            entry.bytes = blob.size;
            totalBytes += blob.size;
            evict();
          } else if (entries.get(job.key) === entry) {
            entries.delete(job.key);
          }
        }
        for (const consumer of job.consumers) {
          if (consumer.shouldCancel?.()) rejectConsumer(consumer, new ThumbnailReadCancelledError());
          else resolveConsumer(consumer, entry.blob ?? blob);
        }
      },
      (error: unknown) => {
        const entry = job.entry;
        if (entries.get(job.key) === entry && entry.job === job && entry.blob === null) {
          entries.delete(job.key);
          totalBytes -= entry.bytes;
        }
        for (const consumer of job.consumers) rejectConsumer(consumer, error);
      },
    )
    .finally(() => {
      job.state = 'settled';
      if (job.entry.job === job) job.entry.job = null;
      finishReadJob(job);
    });
}

/** 滚动期间暂停当前目录/子图包/全库预热，但保留可见和下一屏请求。 */
export function setThumbnailPreloadPaused(paused: boolean): void {
  if (backgroundReadsPaused === paused) return;
  backgroundReadsPaused = paused;
  if (!paused) pumpReadQueue();
}

// —— 调试统计（供设置页“调试”面板展示，定位“大文件夹仍在滚动时加载”等问题）——
export interface RendererThumbnailStats {
  entries: number;
  bytes: number;
  maxBytes: number;
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  prefetchScheduled: number;
  prefetchCompleted: number;
  prefetchFailed: number;
}

const counters = { requests: 0, cacheHits: 0, cacheMisses: 0, prefetchScheduled: 0, prefetchCompleted: 0, prefetchFailed: 0 };

export function getRendererThumbnailStats(): RendererThumbnailStats {
  return { entries: entries.size, bytes: totalBytes, maxBytes: MAX_BYTES, ...counters };
}

/** 清空渲染端缩略图内存缓存（供设置页“清除缓存”调试使用）。 */
export function clearThumbnailCache(): void {
  cacheGeneration++;
  entries.clear();
  totalBytes = 0;
  counters.requests = 0;
  counters.cacheHits = 0;
  counters.cacheMisses = 0;
  counters.prefetchScheduled = 0;
  counters.prefetchCompleted = 0;
  counters.prefetchFailed = 0;
}

function keyOf(file: FileRef, maxSize: number): string {
  return `${file.id}\u0000${file.mtime ?? ''}\u0000${file.size ?? ''}\u0000${maxSize}`;
}

/** 仅按总字节数淘汰（无条数上限）：字节超限时从最久未用开始移除。 */
function evict(): void {
  while (totalBytes > MAX_BYTES && entries.size > 0) {
    // 未决条目还没占用 Blob 字节；删除它们无法降低 totalBytes，
    // 反而会让迟到的结果重新入队。只在已解析条目中选最久未用的一项。
    let oldestKey: string | undefined;
    for (const [key, entry] of entries) {
      if (entry.bytes > 0) {
        oldestKey = key;
        break;
      }
    }
    if (oldestKey === undefined) break;
    const oldest = entries.get(oldestKey);
    entries.delete(oldestKey);
    if (oldest) totalBytes -= oldest.bytes;
  }
}

/**
 * 读取缩略图 Blob。命中缓存时返回已缓存的 Promise（并发挂载共享同一请求），
 * 未命中则通过 store.readThumbnail 生成并缓存。
 * options.low 表示低优先级请求（如预加载），实现（Electron）会把它排在
 * 可见图片之后，避免预加载洪峰拖慢正在显示的缩略图。
 */
/**
 * 同步窥探缓存的缩略图 Blob（仅在已解析时返回，否则 null）。
 * 用于 BlobImage 挂载时直接生成 object URL：命中即出图，不再闪一帧加载条。
 */
export function peekThumbnailBlob(file: FileRef, maxSize: number): Blob | null {
  const key = keyOf(file, maxSize);
  const hit = entries.get(key);
  if (!hit) return null;
  // 刷新 LRU 顺序。
  entries.delete(key);
  entries.set(key, hit);
  return hit.blob;
}

/** 可见请求升级间隔：同一文件太频繁的重进视口不再重复发 IPC。 */
const VISIBLE_PROMOTE_MIN_INTERVAL_MS = 200;

function createConsumer(
  entry: ThumbEntry,
  job: ReadJob,
  shouldCancel: (() => boolean) | undefined,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const consumer: Consumer = { shouldCancel, resolve, reject, settled: false };
    job.consumers.add(consumer);
    if (shouldCancel?.()) rejectConsumer(consumer, new ThumbnailReadCancelledError());
    if (job.state === 'queued' && job.consumers.size === 0) job.state = 'settled';
    pumpReadQueue();
  });
}

function promoteJob(job: ReadJob, priority: number): void {
  const nextPriority = normalizePriority(priority);
  if (job.state !== 'queued' || nextPriority >= job.priority) return;
  job.priority = nextPriority;
  enqueueJob(job);
}

function createJob(
  key: string,
  entry: ThumbEntry,
  store: LibraryStore,
  file: FileRef,
  maxSize: number,
  priority: number,
): ReadJob {
  const job: ReadJob = {
    entry,
    key,
    store,
    file,
    maxSize,
    priority: normalizePriority(priority),
    state: 'queued',
    queueVersion: 0,
    consumers: new Set(),
  };
  entry.job = job;
  enqueueJob(job);
  return job;
}

export function getThumbnailBlob(
  store: LibraryStore,
  file: FileRef,
  maxSize: number,
  options?: { priority?: number; recheck?: boolean; shouldCancel?: () => boolean },
): Promise<Blob> {
  const key = keyOf(file, maxSize);
  const hit = entries.get(key);
  if (hit) {
    entries.delete(key);
    entries.set(key, hit);
    counters.requests++;
    counters.cacheHits++;
    if (hit.blob) return Promise.resolve(hit.blob);

    const job = hit.job;
    if (!job) {
      const replacement = createJob(key, hit, store, file, maxSize, options?.priority ?? THUMB_PRIORITY_VISIBLE);
      return createConsumer(hit, replacement, options?.shouldCancel);
    }
    const requestedPriority = options?.priority ?? THUMB_PRIORITY_VISIBLE;
    const shouldPromote = requestedPriority === THUMB_PRIORITY_VISIBLE || options?.recheck === true;
    if (shouldPromote) {
      const now = Date.now();
      if (hit.lastPromotedAt === undefined || now - hit.lastPromotedAt >= VISIBLE_PROMOTE_MIN_INTERVAL_MS) {
        hit.lastPromotedAt = now;
        promoteJob(job, requestedPriority);
      }
    }
    return createConsumer(hit, job, options?.shouldCancel);
  }

  counters.requests++;
  counters.cacheMisses++;
  const entry: ThumbEntry = {
    blob: null,
    bytes: 0,
    generation: cacheGeneration,
    job: null,
  };
  entries.set(key, entry);
  const job = createJob(key, entry, store, file, maxSize, options?.priority ?? THUMB_PRIORITY_VISIBLE);
  evict();
  return createConsumer(entry, job, options?.shouldCancel);
}


export interface PreloadThumbnailsOptions {
  /** 同时进行的读取数上限，避免一上来就打爆 IPC / 主进程解码队列。默认 2。 */
  concurrency?: number;
  /** 返回 true 时停止后续预加载（用于快速切换目录时取消过期任务）。 */
  shouldStop?: () => boolean;
  /** 队列优先级：0 可见 > 1 滚动方向预取 > 2 当前目录 > 3 子文件夹/封面 > 4 全库预热。默认 2（当前目录）。 */
  priority?: number;
  /**
   * 已预取（排队中）的文件是否重新以本次优先级请求并替换缓存 Promise。
   * 滚动方向预取用 true：否则缓存合并会复用“整目录预取”排在队尾的慢 Promise，
   * 下一屏等于没被优先生成。默认 false。
   */
  recheck?: boolean;
  /** 输出尺寸，封面预热使用更清晰的尺寸。 */
  maxSize?: number;
}

/**
 * 后台预加载一组缩略图（fire-and-forget，失败静默）。
 *
 * 用于"查看某文件夹时提前预热预览图"：把这些缩略图写进缓存后，之后再挂载
 * 对应的 BlobImage 会直接命中缓存，不触发任何解码或 IPC。
 * 已缓存的条目会立即命中返回，所以重复预加载几乎无成本。
 * 通过 priority 把请求排进主进程多级优先级队列（可见 > 当前目录 > 子文件夹
 * > 全库预热），保证用户正在看的图永远先完成。
 */
export function preloadThumbnails(store: LibraryStore, files: FileRef[], options: PreloadThumbnailsOptions = {}): void {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const priority = options.priority ?? 2;
  const recheck = options.recheck === true;
  let index = 0;
  let active = 0;

  const pump = (): void => {
    if (options.shouldStop?.()) return;
    while (active < concurrency && index < files.length) {
      const file = files[index++]!;
      if (options.shouldStop?.()) return;
      active++;
      counters.prefetchScheduled++;
      getThumbnailBlob(store, file, options.maxSize ?? DEFAULT_THUMBNAIL_SIZE, {
        priority,
        recheck,
        shouldCancel: options.shouldStop,
      })
        .then(() => {
          counters.prefetchCompleted++;
        })
        .catch((err: unknown) => {
          // 预加载失败静默；真正显示时 BlobImage 会自行重试并给出失败提示。
          if (!(err instanceof ThumbnailReadCancelledError)) counters.prefetchFailed++;
        })
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  pump();
}
