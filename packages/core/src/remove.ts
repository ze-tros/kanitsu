import type { FolderRef, LibraryStore } from '../../fs-adapter/src/types';
import { normalizeRelPath } from './path';

/** Resolves a library-relative folder path to an existing store folder ref (no creation). */
async function resolveFolder(store: LibraryStore, relPath: string): Promise<FolderRef | null> {
  const root = await store.getLibraryRoot();
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return root;
  let current = root;
  for (const segment of normalized.split('/')) {
    if (!segment) continue;
    let next: FolderRef | null = null;
    for await (const child of store.listChildren(current)) {
      if (child.kind === 'folder' && child.name === segment) {
        next = { id: child.id, name: child.name, kind: 'folder' };
        break;
      }
    }
    if (!next) return null;
    current = next;
  }
  return current;
}

/**
 * Deletes a library folder and all of its descendants (files + subfolders).
 * Returns the removed library-relative path. Throws for the library root.
 */
export async function deleteLibraryFolder(store: LibraryStore, relPath: string): Promise<string> {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) throw new Error('不能删除库根目录。');
  const folder = await resolveFolder(store, normalized);
  if (!folder) throw new Error(`未找到文件夹：${normalized}`);
  await store.remove(folder);
  return normalized;
}
