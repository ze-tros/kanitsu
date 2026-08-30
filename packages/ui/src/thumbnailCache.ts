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
  promise: Promise<Blob>;
  /** 已解析出的 Blob；未决时为 null。 */
  blob: Blob | null;
  /** 已解析出的 Blob 字节数；未决时为 0。 */
  bytes: number;
  /** 创建该条目时的缓存代次，防止 clear 前的请求回填。 */
  generation: number;
  /** 上次被“可见请求升级”的时间戳：防止窗口反复进货时对同一文件狂发 IPC。 */
  lastPromotedAt?: number;
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
  priority: number;
  shouldCancel?: () => boolean;
  start: () => void;
  cancel: () => void;
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
      if (next.shouldCancel?.()) {
        next.cancel();
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
    inFlightReads++;
    if (next.priority > THUMB_PRIORITY_VISIBLE) inFlightNonVisibleReads++;
    next.start();
  }
}

function runWhenSlotFree<T>(
  task: () => Promise<T>,
  options?: { priority?: number; shouldCancel?: () => boolean },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request: QueuedRead = {
      priority: normalizePriority(options?.priority),
      shouldCancel: options?.shouldCancel,
      cancel: () => reject(new ThumbnailReadCancelledError()),
      start: () => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            inFlightReads--;
            if (request.priority > THUMB_PRIORITY_VISIBLE) inFlightNonVisibleReads--;
            pumpReadQueue();
          });
      },
    };
    readQueues[request.priority]!.push(request);
    pumpReadQueue();
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

/**
 * 解析结果写回缓存（幂等：只有首个完成的请求计入字节，避免升级后双记）。
 *
 * 特别注意“重复请求（可见升级/方向预取/原预取）乱序完成”的情况：
 * - 条目还在且未出图：正常写入；
 * - 条目已被删除（另一条重复请求失败清掉了）：这条结果完好，重建缓存，
 *   避免“已经生成过、回看又重载”；
 * - 条目已出图：所有重复请求都返回首个成功的 canonical Blob。
 */
function settleEntry(
  key: string,
  entry: ThumbEntry | null,
  blob: Blob,
): Blob {
  if (!entry) return blob;
  // clear 后旧请求仍可以向原调用者返回结果，但不得触碰新代缓存。
  if (entry.generation !== cacheGeneration) return blob;

  // 升级前后的 Promise 都指向同一条目；首个成功结果是该条目的
  // canonical Blob，后完成的请求必须返回它，不能泄漏另一份 Blob。
  if (entry.blob !== null) return entry.blob;

  const current = entries.get(key);
  let target = entry;
  if (current && current !== entry) {
    // 条目失败被删除后，同键可能已创建了新条目。这份成功结果
    // 可以完成新条目，但绝不覆盖它的条目身份或 Promise 调用者。
    target = current;
    if (target.blob !== null) return target.blob;
  } else if (!current) {
    // 条目被另一条重复请求失败清掉了：用这份成功结果重建。
    // generation 检查保证这不会复活 clear 前的条目。
    if (blob.size <= MAX_SINGLE_BLOB_BYTES) entries.set(key, entry);
  }

  target.blob = blob;
  target.promise = Promise.resolve(blob);
  if (blob.size <= MAX_SINGLE_BLOB_BYTES && entries.get(key) === target) {
    target.bytes = blob.size;
    totalBytes += blob.size;
    evict();
  } else {
    // 超大异常输出不入内存缓存：既省内存，也避免
    // 把其它正常缩略图从 LRU 里挤掉。条目仍保留 canonical Blob，
    // 仅供已在等待的重复 Promise 统一返回，不会被后续 get 命中。
    if (entries.get(key) === target) entries.delete(key);
  }
  return target.blob;
}

/**
 * 失败处理：**绝不删除已经出图的条目**——它可能是另一条重复请求（如可见升级）
 * 先写好、这条慢请求后失败的成果；删了它，回看同一张图就会重新载图。
 * 只在条目还没有任何有效 Blob 时清理。
 */
function failEntry(key: string, entry: ThumbEntry | null, request: Promise<Blob>): void {
  if (
    entry &&
    entries.get(key) === entry &&
    entry.blob === null &&
    entry.promise === request
  ) {
    entries.delete(key);
    totalBytes -= entry.bytes;
  }
}

function createReadPromise(
  key: string,
  getEntry: () => ThumbEntry | null,
  store: LibraryStore,
  file: FileRef,
  maxSize: number,
  priority: number | undefined,
  shouldCancel: (() => boolean) | undefined,
): Promise<Blob> {
  let request!: Promise<Blob>;
  request = runWhenSlotFree(
    () => store.readThumbnail(file, maxSize, { priority }),
    { priority, shouldCancel },
  ).then(
    (blob) => settleEntry(key, getEntry(), blob),
    (err: unknown) => {
      failEntry(key, getEntry(), request);
      throw err;
    },
  );
  return request;
}

/** 可见请求升级间隔：同一文件太频繁的重进视口不再重复发 IPC。 */
const VISIBLE_PROMOTE_MIN_INTERVAL_MS = 200;

export function getThumbnailBlob(
  store: LibraryStore,
  file: FileRef,
  maxSize: number,
  options?: { priority?: number; recheck?: boolean; shouldCancel?: () => boolean },
): Promise<Blob> {
  const key = keyOf(file, maxSize);
  const hit = entries.get(key);
  if (hit) {
    // 刷新 LRU 顺序。
    entries.delete(key);
    entries.set(key, hit);
    counters.requests++;
    counters.cacheHits++;
    if (hit.blob) return hit.promise; // 已出图：直接复用，不必再请求
    const level = options?.priority ?? 0;
    if (level === 0) {
      // —— 可见请求绝不能挂在身后的慢速预取（整目录 FIFO）上 ——
      // 缓存合并会让可见请求复用预取的 Promise，等于排到数千张的队尾。
      // 这里把条目的 Promise 升级为一条新的优先 0 请求：插队生成，先于预取出图；
      // 预取那条稍后完成时结果幂等（settleEntry 只记一次）。带节流防重。
      const now = Date.now();
      if (hit.lastPromotedAt !== undefined && now - hit.lastPromotedAt < VISIBLE_PROMOTE_MIN_INTERVAL_MS) {
        return hit.promise;
      }
      hit.lastPromotedAt = now;
      hit.promise = createReadPromise(
        key,
        () => hit,
        store,
        file,
        maxSize,
        THUMB_PRIORITY_VISIBLE,
        options?.shouldCancel,
      );
    } else if (options?.recheck) {
      // 滚动方向预取（优先级 1）：同一文件已排在整目录预取（优先级 2）队尾时，
      // 合并返回慢 Promise 等于没预取。重新以优先 1 请求并替换条目 Promise，
      // 让 worker 先出下一屏的图（带节流，防重复进视口刷 IPC）。
      const now = Date.now();
      if (hit.lastPromotedAt !== undefined && now - hit.lastPromotedAt < VISIBLE_PROMOTE_MIN_INTERVAL_MS) {
        return hit.promise;
      }
      hit.lastPromotedAt = now;
      hit.promise = createReadPromise(
        key,
        () => hit,
        store,
        file,
        maxSize,
        options.priority ?? THUMB_PRIORITY_DIRECTIONAL,
        options.shouldCancel,
      );
    }
    return hit.promise;
  }
  counters.requests++;
  counters.cacheMisses++;

  let entry: ThumbEntry | null = null;
  const promise = createReadPromise(
    key,
    () => entry,
    store,
    file,
    maxSize,
    options?.priority,
    options?.shouldCancel,
  );
  entry = { promise, blob: null, bytes: 0, generation: cacheGeneration };
  entries.set(key, entry);
  evict();
  return promise;
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
