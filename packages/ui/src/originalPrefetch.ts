/**
 * 查看器原图预解码池，桌面查看器（desktop/Viewer）与移动查看器（mobile/MobileViewer）共用。
 */
// ---- 查看器：已解码原图缓存池（LRU，按估算字节限流）----
// 查看器始终显示原始分辨率原图，大图解码是切换卡顿的主因。这里预解码相邻
// 原图并把位图留在内存里（LRU），来回切换时 Chromium 直接复用已解码像素，
// 而不是每次现场解码。只用游离的 Image 对象，绝不触碰 React 渲染的元素。
const ORIGINAL_POOL_MAX_ENTRIES = 16;
const ORIGINAL_POOL_MAX_BYTES = 384 * 1024 * 1024; // RGBA 估算上限（约合几张千万像素图）
const ORIGINAL_POOL = new Map<string, HTMLImageElement>(); // 迭代序 = 插入序（LRU）
let ORIGINAL_POOL_BYTES = 0;

function estimatedImageBytes(width: number | undefined, height: number | undefined): number {
  return width && height && width > 0 && height > 0 ? width * height * 4 : 0;
}

function originalPoolTouch(url: string): void {
  const img = ORIGINAL_POOL.get(url);
  if (!img) return;
  ORIGINAL_POOL.delete(url);
  ORIGINAL_POOL.set(url, img);
}

/** 释放不再保留的 URL（web/memory 实现生成 blob: URL 需要 revoke；协议 URL 是 no-op）。 */
function releasePooledUrl(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

function originalPoolEvict(): void {
  while (
    (ORIGINAL_POOL.size > ORIGINAL_POOL_MAX_ENTRIES || ORIGINAL_POOL_BYTES > ORIGINAL_POOL_MAX_BYTES) &&
    ORIGINAL_POOL.size > 0
  ) {
    const oldestUrl = ORIGINAL_POOL.keys().next().value;
    if (oldestUrl === undefined) break;
    const img = ORIGINAL_POOL.get(oldestUrl);
    ORIGINAL_POOL.delete(oldestUrl);
    if (img) {
      ORIGINAL_POOL_BYTES -= estimatedImageBytes(img.naturalWidth, img.naturalHeight);
      img.removeAttribute('src'); // 释放解码位图引用
      releasePooledUrl(oldestUrl);
    }
  }
}

function originalPoolPut(url: string, img: HTMLImageElement): void {
  const bytes = estimatedImageBytes(img.naturalWidth, img.naturalHeight);
  const existing = ORIGINAL_POOL.get(url);
  if (existing) {
    ORIGINAL_POOL.delete(url);
    ORIGINAL_POOL_BYTES -= estimatedImageBytes(existing.naturalWidth, existing.naturalHeight);
  }
  ORIGINAL_POOL.set(url, img);
  ORIGINAL_POOL_BYTES += bytes;
  originalPoolEvict();
}

/** 预解码一张原图并把位图放入缓存池。 */
export function prefetchOriginal(url: string, estWidth?: number, estHeight?: number): void {
  if (ORIGINAL_POOL.has(url)) {
    originalPoolTouch(url);
    return;
  }
  // 预估内存超限则不预解码，避免压垮内存。
  if (ORIGINAL_POOL_BYTES + estimatedImageBytes(estWidth, estHeight) > ORIGINAL_POOL_MAX_BYTES * 2) {
    releasePooledUrl(url);
    return;
  }
  const img = new Image();
  img.decoding = 'async';
  // onload 只代表字节就绪；必须 decode() 出完整位图再入池，否则池里放的是
  // 未解码的图，首次显示/缩放仍会现场解码大图，预取就失去意义。
  img.onload = () => {
    void img
      .decode()
      .then(() => originalPoolPut(url, img))
      .catch(() => {
        ORIGINAL_POOL.delete(url);
        releasePooledUrl(url);
      });
  };
  img.onerror = () => {
    ORIGINAL_POOL.delete(url);
    releasePooledUrl(url);
  };
  img.src = url;
}

/** 返回已预解码的原图尺寸，让查看器可以跳过第二次等待。 */
export function peekPrefetchedOriginal(url: string): { w: number; h: number } | null {
  const img = ORIGINAL_POOL.get(url);
  if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return null;
  originalPoolTouch(url);
  return { w: img.naturalWidth, h: img.naturalHeight };
}
