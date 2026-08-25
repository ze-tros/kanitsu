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
  /** 上次被“可见请求升级”的时间戳：防止窗口反复进货时对同一文件狂发 IPC。 */
  lastPromotedAt?: number;
}

const MAX_BYTES = 256 * 1024 * 1024; // 256MB：512px 缩略图约 7–30KB/张，容量封顶即可
/** 单条超过该字节数（多为 GIF 原样大字节）不进内存缓存，避免挤垮 LRU。 */
const MAX_SINGLE_BLOB_BYTES = 512 * 1024;

// Map 迭代序即 LRU 序（最久未用在前）。
const entries = new Map<string, ThumbEntry>();
let totalBytes = 0;

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
    const oldestKey = entries.keys().next().value;
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
 * - 条目已出图：幂等跳过（先完成的已记账）。
 */
function settleEntry(
  key: string,
  entry: ThumbEntry | null,
  blob: Blob,
): Blob {
  if (!entry) return blob;
  if (entries.get(key) !== entry) {
    // 条目被其它重复请求失败清掉了：用这份成功结果重建。
    if (blob.size <= MAX_SINGLE_BLOB_BYTES) {
      entry.blob = null;
      entry.bytes = 0;
      entry.promise = Promise.resolve(blob);
      entries.set(key, entry);
    } else {
      return blob; // 超大 Blob 不入内存缓存（约定同下）
    }
  }
  if (entry.blob === null) {
    if (blob.size <= MAX_SINGLE_BLOB_BYTES) {
      entry.blob = blob;
      entry.bytes = blob.size;
      totalBytes += blob.size;
    } else {
      // 超大 Blob（多为 GIF 原样大字节）不入内存缓存：既省内存，也避免
      // 把其它正常缩略图从 LRU 里挤掉（正是“滚动才加载、磁盘命中重取”的根源）。
      entries.delete(key);
    }
  }
  return blob;
}

/**
 * 失败处理：**绝不删除已经出图的条目**——它可能是另一条重复请求（如可见升级）
 * 先写好、这条慢请求后失败的成果；删了它，回看同一张图就会重新载图。
 * 只在条目还没有任何有效 Blob 时清理。
 */
function failEntry(key: string, entry: ThumbEntry | null): void {
  if (entry && entries.get(key) === entry && entry.blob === null) {
    entries.delete(key);
    totalBytes -= entry.bytes;
  }
}

/** 可见请求升级间隔：同一文件太频繁的重进视口不再重复发 IPC。 */
const VISIBLE_PROMOTE_MIN_INTERVAL_MS = 200;

export function getThumbnailBlob(
  store: LibraryStore,
  file: FileRef,
  maxSize: number,
  options?: { priority?: number; recheck?: boolean },
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
      hit.promise = Promise.resolve(store.readThumbnail(file, maxSize, { priority: 0 })).then(
        (blob) => settleEntry(key, hit, blob),
        (err: unknown) => {
          failEntry(key, hit);
          throw err;
        },
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
      hit.promise = Promise.resolve(
        store.readThumbnail(file, maxSize, { priority: options.priority ?? 1 }),
      ).then(
        (blob) => settleEntry(key, hit, blob),
        (err: unknown) => {
          failEntry(key, hit);
          throw err;
        },
      );
    }
    return hit.promise;
  }
  counters.requests++;
  counters.cacheMisses++;

  let entry: ThumbEntry | null = null;
  const promise = Promise.resolve(
    store.readThumbnail(file, maxSize, { priority: options?.priority }),
  ).then(
    (blob) => settleEntry(key, entry, blob),
    (err: unknown) => {
      failEntry(key, entry);
      throw err;
    },
  );
  entry = { promise, blob: null, bytes: 0 };
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
}

const DEFAULT_PRELOAD_MAX_SIZE = 512;

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
      getThumbnailBlob(store, file, DEFAULT_PRELOAD_MAX_SIZE, { priority, recheck })
        .then(() => {
          counters.prefetchCompleted++;
        })
        .catch(() => {
          // 预加载失败静默；真正显示时 BlobImage 会自行重试并给出失败提示。
          counters.prefetchFailed++;
        })
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  pump();
}