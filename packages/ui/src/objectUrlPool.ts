/**
 * object URL 小池（性能优化 P4）。
 *
 * 旧实现每张图挂载时 `createObjectURL`、卸载时 `revokeObjectURL`，在快速
 * 滚动 / 目录切换下会持续创建与撤销 URL。这里对"近期展示过的 Blob"保留一个
 * 小的 LRU 池：
 *  - 同一 Blob 永远复用同一个 URL（WeakMap 去重），切换回旧目录时零新建；
 *  - 组件卸载只把 URL "交还"池子，不立即撤销；
 *  - 引用计数保证正在 <img> 上展示的 URL 绝不会被撤掉（否则会破图）；
 *  - 池超限时只淘汰最久未用的"空闲"条目并撤销其 URL。
 */
interface PoolEntry {
  blob: Blob;
  url: string;
  /** 当前被元素占用（未 release）的引用数。 */
  refs: number;
  /** 最近一次使用时间（仅用于淘汰空闲条目，不参与渲染）。 */
  lastUsed: number;
}

/** 保留的空闲 URL 上限（文档目标 30~60，取 64；配合虚拟化足够覆盖滚动复现）。 */
const MAX_IDLE = 64;
/** 兜底：池内全部 Blob 的字节上限，防止异常大 Blob 撑爆池。 */
const MAX_TOTAL_BYTES = 384 * 1024 * 1024;

/** url -> entry；Map 迭代序即最近使用序（最新在后）。 */
const entries = new Map<string, PoolEntry>();
/** blob -> url：同一 Blob 只创建一个 URL。 */
const blobToUrl = new WeakMap<Blob, string>();
let totalBytes = 0;

function drop(url: string): void {
  const entry = entries.get(url);
  if (!entry) return;
  entries.delete(url);
  blobToUrl.delete(entry.blob);
  totalBytes -= entry.blob.size;
  URL.revokeObjectURL(url);
}

function evict(): void {
  // 收集需要淘汰的空闲条目（只淘汰 refs===0）。
  const droppable: string[] = [];
  let idle = 0;
  for (const entry of entries.values()) {
    if (entry.refs === 0) idle++;
  }
  for (const entry of entries.values()) {
    if (idle <= MAX_IDLE && totalBytes <= MAX_TOTAL_BYTES) break;
    if (entry.refs === 0) {
      droppable.push(entry.url);
      idle--;
    }
  }
  for (const url of droppable) drop(url);
}

/**
 * 取一个对象 URL 供 <img>/<video> 展示；组件销毁时必须调用 releaseObjectUrl
 * 把引用还回池子。同一 Blob 重复 acquire 返回同一个 URL（引用计数叠加）。
 */
export function acquireObjectUrl(blob: Blob): string {
  const existingUrl = blobToUrl.get(blob);
  if (existingUrl) {
    const entry = entries.get(existingUrl);
    if (entry) {
      // 复用既有 URL：引用 +1，并刷新 LRU 顺序。
      entry.refs++;
      entry.lastUsed = performance.now();
      entries.delete(existingUrl);
      entries.set(existingUrl, entry);
      return existingUrl;
    }
    // 正常情况下不会走到：WeakMap 与 entries 同步增删。
    blobToUrl.delete(blob);
  }
  const url = URL.createObjectURL(blob);
  const now = performance.now();
  entries.set(url, { blob, url, refs: 1, lastUsed: now });
  blobToUrl.set(blob, url);
  totalBytes += blob.size;
  evict();
  return url;
}

/**
 * 交还对象 URL 到池中（不立即撤销）。refs 归零后成为空闲条目，超限时才会被
 * 淘汰撤销；未超限则继续复用，避免创建/撤销抖动。
 */
export function releaseObjectUrl(url: string): void {
  const entry = entries.get(url);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  entry.lastUsed = performance.now();
  entries.delete(url);
  entries.set(url, entry);
  evict();
}
