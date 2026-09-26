import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import type { FolderNode, ImageEntry, LibrarySnapshot } from './types';
import { canonicalizeRelPath, normalizeRelPath, parentRelPath } from './path';
import { stableHash } from './hash';
import { resolveFolderRef } from './entry-ops';
import { nextUniqueName, type OrganizeAction, type OrganizeManifest } from './organize';

export interface MoveSelection {
  imageIds: string[];
  folderIds: string[];
}

export interface MoveEntriesOptions {
  /** Called with `(processed, total)` after each image / folder. */
  onProgress?: (done: number, total: number) => void;
}

export interface MoveFailure {
  kind: 'image' | 'folder';
  id: string;
  name: string;
  reason: 'invalid-target' | 'target-exists' | 'move-failed';
}

export interface MoveEntriesResult {
  /** 已移动图片的清单，可用 undoOrganize 还原（图包移动不进清单）。 */
  manifest: OrganizeManifest;
  movedImages: number;
  movedFolders: number;
  failures: MoveFailure[];
}

function isRelPrefix(prefix: string, path: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * 把所选图片与图包移动到图库内的目标目录。
 * - 图片与目标目录里的文件重名时自动追加序号，不覆盖已有文件；
 * - 图包整体移动（保留子目录），目标里已有同名图包、或目标位于该图包自身之内时跳过；
 * - 已在目标目录里的条目、以及随所选祖先图包一起移动的后代条目不再单独处理。
 * 单项失败不中断整批，失败明细进入结果。
 */
export async function moveEntries(
  store: LibraryStore,
  snapshot: LibrarySnapshot,
  targetRelPath: string,
  selection: MoveSelection,
  options: MoveEntriesOptions = {},
): Promise<MoveEntriesResult> {
  const targetRel = canonicalizeRelPath(targetRelPath);
  const target = await resolveFolderRef(store, targetRel);
  if (!target) throw new Error(`未找到目标文件夹：${targetRel || '图库根目录'}`);

  const folders: FolderNode[] = [];
  for (const id of selection.folderIds) {
    const folder = snapshot.folders[id];
    if (folder && folder.relPath) folders.push(folder);
  }
  // 只处理最顶层的所选图包：嵌套图包随祖先一起移动。
  const topFolders = folders.filter(
    (folder) => !folders.some((other) => other.id !== folder.id && isRelPrefix(other.relPath, folder.relPath)),
  );
  const images: ImageEntry[] = [];
  for (const id of selection.imageIds) {
    const image = snapshot.images[id];
    if (!image) continue;
    if (topFolders.some((folder) => isRelPrefix(folder.relPath, image.relPath))) continue;
    if (parentRelPath(normalizeRelPath(image.relPath)) === targetRel) continue;
    images.push(image);
  }

  const failures: MoveFailure[] = [];
  const actions: OrganizeAction[] = [];
  const total = images.length + topFolders.length;
  let done = 0;
  options.onProgress?.(0, total);

  // 目标目录现有的文件名 / 子目录名，用于重名判断（随移动实时更新）。
  const takenFiles = new Set<string>();
  const takenFolders = new Set<string>();
  for await (const child of store.listChildren(target)) {
    if (child.kind === 'file') takenFiles.add(child.name);
    else takenFolders.add(child.name);
  }

  let movedImages = 0;
  for (const image of images) {
    try {
      const source: FileRef = { id: image.fileRefId ?? image.id, name: image.name, kind: 'file' };
      const finalName = takenFiles.has(image.name) ? nextUniqueName(takenFiles, image.name) : image.name;
      const moved = await store.move(source, target, finalName);
      const toName = moved.kind === 'file' ? moved.name : finalName;
      takenFiles.add(toName);
      actions.push({
        fromRelPath: parentRelPath(normalizeRelPath(image.relPath)),
        fromName: image.name,
        toRelPath: targetRel,
        toName,
      });
      movedImages++;
    } catch {
      failures.push({ kind: 'image', id: image.id, name: image.name, reason: 'move-failed' });
    }
    options.onProgress?.(++done, total);
  }

  let movedFolders = 0;
  for (const folder of topFolders) {
    const fail = (reason: MoveFailure['reason']) => failures.push({ kind: 'folder', id: folder.id, name: folder.name, reason });
    if (isRelPrefix(folder.relPath, targetRel)) fail('invalid-target');
    else if (parentRelPath(folder.relPath) === targetRel) {
      // 已经在目标目录里，无需移动。
    } else if (takenFolders.has(folder.name)) fail('target-exists');
    else {
      try {
        const source = await resolveFolderRef(store, folder.relPath);
        if (!source) throw new Error('missing');
        await store.move(source, target, folder.name);
        takenFolders.add(folder.name);
        movedFolders++;
      } catch {
        fail('move-failed');
      }
    }
    options.onProgress?.(++done, total);
  }

  const manifest: OrganizeManifest = {
    id: stableHash(`move-${Date.now()}-${Math.random()}`),
    createdAt: Date.now(),
    containerRelPath: targetRel,
    actions,
  };
  return { manifest, movedImages, movedFolders, failures };
}

