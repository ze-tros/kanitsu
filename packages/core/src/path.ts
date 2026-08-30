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
