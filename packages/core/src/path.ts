export function normalizeRelPath(path: string): string {
  let p = path.replace(/\\/g, '/');
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/^\/+|\/+$/g, '');
  return p;
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

const SUPPORTED_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif']);

export function isSupportedImage(name: string): boolean {
  return SUPPORTED_IMAGE_EXT.has(extOf(name));
}
