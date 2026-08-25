import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';

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
  /** 已解析出的 Blob 字节数；未决时为 0。 */
  bytes: number;
}

const MAX_ENTRIES = 600;
const MAX_BYTES = 64 * 1024 * 1024; // ~64MB：512px 缩略图约 20–60KB/张

// Map 迭代序即 LRU 序（最久未用在前）。
const entries = new Map<string, ThumbEntry>();
let totalBytes = 0;

function keyOf(file: FileRef, maxSize: number): string {
  return `${file.id}\u0000${file.mtime ?? ''}\u0000${file.size ?? ''}\u0000${maxSize}`;
}

function evict(): void {
  while ((entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) && entries.size > 0) {
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
export function getThumbnailBlob(
  store: LibraryStore,
  file: FileRef,
  maxSize: number,
  options?: { low?: boolean },
): Promise<Blob> {
  const key = keyOf(file, maxSize);
  const hit = entries.get(key);
  if (hit) {
    // 刷新 LRU 顺序。
    entries.delete(key);
    entries.set(key, hit);
    return hit.promise;
  }

  let entry: ThumbEntry | null = null;
  const promise = Promise.resolve(store.readThumbnail(file, maxSize, options)).then(
    (blob) => {
      // 仅当条目仍在缓存中（未被 LRU 淘汰）时计入字节数。
      if (entry && entries.get(key) === entry) {
        entry.bytes = blob.size;
        totalBytes += blob.size;
      }
      return blob;
    },
    (err: unknown) => {
      // 失败不缓存，下次可重试。
      if (entry && entries.get(key) === entry) {
        entries.delete(key);
        totalBytes -= entry.bytes;
      }
      throw err;
    },
  );
  entry = { promise, bytes: 0 };
  entries.set(key, entry);
  evict();
  return promise;
}

export interface PreloadThumbnailsOptions {
  /** 同时进行的读取数上限，避免一上来就打爆 IPC / 主进程解码队列。默认 4。 */
  concurrency?: number;
  /** 返回 true 时停止后续预加载（用于快速切换目录时取消过期任务）。 */
  shouldStop?: () => boolean;
}

const DEFAULT_PRELOAD_MAX_SIZE = 512;

/**
 * 后台预加载一组缩略图（fire-and-forget，失败静默）。
 *
 * 用于"查看某文件夹时提前预热子文件夹的预览图"：把这些缩略图写进缓存后，
 * 之后再挂载对应的 BlobImage 会直接命中缓存，不触发任何解码或 IPC。
 * 已缓存的条目会立即命中返回，所以重复预加载几乎无成本。
 * 预加载请求标记为低优先级（low），在 Electron worker 队列里排在可见图片之后。
 */
export function preloadThumbnails(store: LibraryStore, files: FileRef[], options: PreloadThumbnailsOptions = {}): void {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  let index = 0;
  let active = 0;

  const pump = (): void => {
    if (options.shouldStop?.()) return;
    while (active < concurrency && index < files.length) {
      const file = files[index++]!;
      if (options.shouldStop?.()) return;
      active++;
      getThumbnailBlob(store, file, DEFAULT_PRELOAD_MAX_SIZE, { low: true })
        .catch(() => {
          // 预加载失败静默；真正显示时 BlobImage 会自行重试并给出失败提示。
        })
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  pump();
}