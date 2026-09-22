export function normalizeRelPath(path: string): string {
  let p = path.replace(/\\/g, '/');
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/^\/+|\/+$/g, '');
  return p;
}

/**
 * Normalizes a library-relative path AND resolves `.` / `..` segments.
 * Throws when the path tries to escape above the library root.
 */
export function canonicalizeRelPath(path: string): string {
  const segments = normalizeRelPath(path).split('/').filter(Boolean);
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) throw new Error(`路径越界：${path}`);
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

export function joinRelPath(base: string, ...parts: string[]): string {
  const all = [base, ...parts].filter(Boolean);
  return normalizeRelPath(all.join('/'));
}

export function parentRelPath(relPath: string): string {
  const p = normalizeRelPath(relPath);
  if (!p) return '';
  const idx = p.lastIndexOf('/');
  return idx < 0 ? '' : p.slice(0, idx);
}

export function baseNameOfRelPath(relPath: string): string {
  const p = normalizeRelPath(relPath);
  if (!p) return '';
  const idx = p.lastIndexOf('/');
  return idx < 0 ? p : p.slice(idx + 1);
}

export function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx < 0 ? '' : name.slice(idx + 1).toLowerCase();
}

const SUPPORTED_IMAGE_EXT = new Set(['jpg', 'jpe', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif']);

export function isSupportedImage(name: string): boolean {
  return SUPPORTED_IMAGE_EXT.has(extOf(name));
}

/**
 * 主流相机 RAW 扩展名(小写)。与普通图片分开维护:只有显式开启 RAW 的平台
 * (桌面/Android)才会把 RAW 计入扫描结果;web demo 不开启,避免收录后无法显示。
 * RAW 的解码/缩略图由专门的管线处理,不经过浏览器 <img>。
 */
export const RAW_IMAGE_EXT = new Set([
  'cr2', // Canon
  'cr3', // Canon
  'nef', // Nikon
  'nrw', // Nikon
  'arw', // Sony
  'dng', // Adobe / 手机 DNG
  'raf', // Fujifilm
  'orf', // Olympus
  'rw2', // Panasonic
  'pef', // Pentax
  'srw', // Samsung
]);

export function isRawImage(name: string): boolean {
  return RAW_IMAGE_EXT.has(extOf(name));
}

/**
 * HEIF/HEIC 容器扩展名(小写)。与 RAW 分开维护:解码库完全不同(libraw 解不了
 * HEIF),且 Chromium/Electron 的 <img> 与 nativeImage 同样解不了 HEVC 编码的
 * HEIF,因此只有具备专用解码管线的平台(桌面/Android)才会收录;web demo 不开启。
 * 桌面经 libheif wasm 解码,Android 走原生 ImageDecoder。
 */
export const HEIF_IMAGE_EXT = new Set([
  'heic', // Apple / 手机照片
  'heif', // 通用 HEIF
  'hif', // Canon / Sony / Panasonic 相机 HEIF
]);

export function isHeifImage(name: string): boolean {
  return HEIF_IMAGE_EXT.has(extOf(name));
}
