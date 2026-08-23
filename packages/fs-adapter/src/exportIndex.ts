/**
 * Builds a portable `index.json` that is embedded into an exported zip so the
 * archive carries metadata about the folder tree and the images it contains.
 */

export interface ExportFileMeta {
  /** Library-relative path (``-separated), equal to the entry path inside the zip. */
  relPath: string;
  size: number;
  mtime: number;
}

export interface ExportFolderIndex {
  relPath: string;
  name: string;
  directImageCount: number;
  imageCount: number;
  childCount: number;
}

export interface ExportImageIndex {
  relPath: string;
  name: string;
  size: number;
  mtime: number;
  ext: string;
}

export interface ExportIndex {
  version: 1;
  exportedAt: number;
  /** Exported folder name (`` for whole-library export). */
  root: string;
  folders: ExportFolderIndex[];
  images: ExportImageIndex[];
}

function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx < 0 ? relPath : relPath.slice(idx + 1);
}

function parentRel(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx < 0 ? '' : relPath.slice(0, idx);
}

function extOf(relPath: string): string {
  const idx = relPath.lastIndexOf('.');
  return idx < 0 ? '' : relPath.slice(idx + 1).toLowerCase();
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
}

export function buildExportIndex(
  root: string,
  files: ExportFileMeta[],
  exportedAt = Date.now(),
): ExportIndex {
  const normRoot = normalizeRel(root);

  const images: ExportImageIndex[] = files
    .map((f) => ({
      relPath: normalizeRel(f.relPath),
      name: baseName(normalizeRel(f.relPath)),
      size: f.size,
      mtime: f.mtime,
      ext: extOf(f.relPath),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  // All distinct parent folders of every file (excluding the library root '').
  const folderSet = new Set<string>();
  for (const image of images) {
    let p = parentRel(image.relPath);
    while (p && !folderSet.has(p)) {
      folderSet.add(p);
      p = parentRel(p);
    }
  }

  const folders: ExportFolderIndex[] = [...folderSet]
    .sort((a, b) => a.localeCompare(b))
    .map((relPath) => {
      const directImageCount = images.filter((im) => parentRel(im.relPath) === relPath).length;
      const imageCount = images.filter((im) => im.relPath.startsWith(`${relPath}/`)).length;
      const childCount = [...folderSet].filter((cur) => parentRel(cur) === relPath).length;
      return { relPath, name: baseName(relPath), directImageCount, imageCount, childCount };
    });

  return { version: 1, exportedAt, root: normRoot, folders, images };
}

export function buildExportIndexJson(
  root: string,
  files: ExportFileMeta[],
  exportedAt?: number,
): string {
  return JSON.stringify(buildExportIndex(root, files, exportedAt));
}
