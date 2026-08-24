import type { FileRef, FolderRef, LibraryStore } from '../../fs-adapter/src/types';
import type { FolderNode, ImageEntry } from './types';
import { extOf, parentRelPath } from './path';

function cleanEntryName(name: string): string {
  const clean = name.trim();
  if (!clean) throw new Error('名称不能为空。');
  if (/[\\/]/.test(clean)) throw new Error('名称不能包含路径分隔符。');
  return clean;
}

/** Resolves a library-relative folder path to the platform folder ref (no creation). */
export async function resolveFolderRef(store: LibraryStore, relPath: string): Promise<FolderRef | null> {
  const root = await store.getLibraryRoot();
  const normalized = relPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
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

/** Resolves an image to its current platform file ref using its snapshot relPath + name. */
export async function resolveImageFileRef(store: LibraryStore, image: ImageEntry): Promise<FileRef | null> {
  const folder = await resolveFolderRef(store, parentRelPath(image.relPath));
  if (!folder) return null;
  for await (const child of store.listChildren(folder)) {
    if (child.kind === 'file' && child.name === image.name) {
      return { id: child.id, name: child.name, kind: 'file', size: child.size, mtime: child.mtime };
    }
  }
  return null;
}

async function hasChild(store: LibraryStore, folder: FolderRef, name: string, kind: 'file' | 'folder'): Promise<boolean> {
  for await (const child of store.listChildren(folder)) {
    if (child.kind === kind && child.name === name) return true;
  }
  return false;
}

/** Renames an image inside its current folder, preserving the extension when omitted. */
export async function renameImage(store: LibraryStore, image: ImageEntry, newName: string): Promise<FileRef> {
  const clean = cleanEntryName(newName);
  let finalName = clean;
  const oldDot = image.name.lastIndexOf('.');
  if (oldDot > 0 && !finalName.includes('.')) finalName = `${finalName}.${extOf(image.name)}`;
  if (finalName === image.name) return { id: image.fileRefId ?? image.id, name: image.name, kind: 'file' };

  const source = await resolveImageFileRef(store, image);
  if (!source) throw new Error(`未找到图片：${image.relPath}`);
  const folder = await resolveFolderRef(store, parentRelPath(image.relPath));
  if (!folder) throw new Error(`未找到所在文件夹：${parentRelPath(image.relPath)}`);
  if (await hasChild(store, folder, finalName, 'file')) throw new Error(`已存在同名文件：${finalName}`);
  const moved = await store.move(source, folder, finalName);
  if (moved.kind !== 'file') throw new Error(`重命名失败：${image.name}`);
  return moved;
}

/** Deletes one image from the app-owned library. */
export async function deleteImage(store: LibraryStore, image: ImageEntry): Promise<void> {
  const source = await resolveImageFileRef(store, image);
  if (!source) throw new Error(`未找到图片：${image.relPath}`);
  await store.remove(source);
}

/** Creates a new empty folder inside the given library-relative parent folder. */
export async function createSubfolder(store: LibraryStore, parentRel: string, name: string): Promise<FolderRef> {
  const clean = cleanEntryName(name);
  const parent = await resolveFolderRef(store, parentRel);
  if (!parent) throw new Error(`未找到父文件夹：${parentRel}`);
  if (await hasChild(store, parent, clean, 'folder')) throw new Error(`已存在同名文件夹：${clean}`);
  return store.createFolder(parent, clean);
}

/** Renames a folder (image pack) inside the app-owned library. */
export async function renameFolder(store: LibraryStore, folder: FolderNode, newName: string): Promise<FolderRef> {
  const clean = cleanEntryName(newName);
  if (!folder.relPath) throw new Error('不能重命名库根目录。');
  if (clean === folder.name) return { id: folder.id, name: folder.name, kind: 'folder' };

  const source = await resolveFolderRef(store, folder.relPath);
  if (!source) throw new Error(`未找到文件夹：${folder.relPath}`);
  const parent = await resolveFolderRef(store, parentRelPath(folder.relPath));
  if (!parent) throw new Error(`未找到父文件夹：${parentRelPath(folder.relPath)}`);
  if (await hasChild(store, parent, clean, 'folder')) throw new Error(`已存在同名文件夹：${clean}`);
  const moved = await store.move(source, parent, clean);
  if (moved.kind !== 'folder') throw new Error(`重命名失败：${folder.name}`);
  return moved;
}
