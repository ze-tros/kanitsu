import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import type { FolderNode, ImageEntry, LibrarySnapshot } from './types';
import { canonicalizeRelPath, joinRelPath, normalizeRelPath, parentRelPath } from './path';
import { stableHash } from './hash';
import { imagesOf } from './scan';
import { createSubfolder } from './entry-ops';
import { deleteLibraryFolder } from './remove';
import { nextUniqueName, type OrganizeAction, type OrganizeConflict, type OrganizeManifest } from './organize';

export interface MergePacksSelection {
  imageIds: string[];
  folderIds: string[];
}

export interface MergePacksOptions {
  /** Called with `(processed, total)` as each image is moved. */
  onProgress?: (done: number, total: number) => void;
}

export interface MergePacksResult {
  /** 与整理同构的移动清单，可用 undoOrganize 还原（被删的原图包目录会按需重建）。 */
  manifest: OrganizeManifest;
  createdRelPath: string;
  movedCount: number;
  /** 所有图片都已移出、连同空子目录一起删除的原图包（库相对路径）。 */
  removedFolderRels: string[];
  /** 仍有图片留在原地（移动失败）而保留的原图包（库相对路径）。 */
  keptFolderRels: string[];
  conflicts: OrganizeConflict[];
}

function isRelPrefix(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * 把选中的图片与图包合并进当前目录下的一个新图包（图包 = 文件夹）。
 * 图包子树里的每一张图片（含全部子图包）都扁平移入新图包，重名自动改名；
 * 每张图片都已移出的被合并图包连同空子目录一起删除，仍有图片的保留原样。
 */
export async function mergeIntoNewPack(
  store: LibraryStore,
  snapshot: LibrarySnapshot,
  containerRelPath: string,
  name: string,
  selection: MergePacksSelection,
  options: MergePacksOptions = {},
): Promise<MergePacksResult> {
  const containerRel = canonicalizeRelPath(containerRelPath);

  // 收集目标图片：所选图片 + 所选图包子树里的全部图片。按 id 去重，
  // 嵌套图包 / “图片与其所在图包同时选中”不会重复移动。
  const targets = new Map<string, ImageEntry>();
  for (const imageId of selection.imageIds) {
    const image = snapshot.images[imageId];
    if (image) targets.set(image.id, image);
  }
  const selectedFolders: FolderNode[] = [];
  for (const folderId of selection.folderIds) {
    const folder = snapshot.folders[folderId];
    if (!folder || !folder.relPath) continue;
    selectedFolders.push(folder);
    for (const image of imagesOf(snapshot, folder.id)) targets.set(image.id, image);
  }
  if (targets.size === 0 && selectedFolders.length === 0) throw new Error('未选择任何图片或图包。');

  const created = await createSubfolder(store, containerRel, name);
  const createdRelPath = joinRelPath(containerRel, created.name);

  const actions: OrganizeAction[] = [];
  const conflicts: OrganizeConflict[] = [];
  const movedIds = new Set<string>();
  const takenNames = new Set<string>();
  const list = [...targets.values()];
  const total = list.length;
  options.onProgress?.(0, total);
  let processed = 0;
  for (const image of list) {
    processed++;
    options.onProgress?.(processed, total);
    try {
      const source: FileRef = { id: image.fileRefId ?? image.id, name: image.name, kind: 'file' };
      const finalName = takenNames.has(image.name) ? nextUniqueName(takenNames, image.name) : image.name;
      const moved = await store.move(source, created, finalName);
      const toName = moved.kind === 'file' ? moved.name : finalName;
      takenNames.add(toName);
      actions.push({
        fromRelPath: parentRelPath(normalizeRelPath(image.relPath)),
        fromName: image.name,
        toRelPath: createdRelPath,
        toName,
      });
      movedIds.add(image.id);
    } catch {
      conflicts.push({ imageId: image.id, name: image.name, targetRelPath: createdRelPath, reason: 'move-failed' });
    }
  }

  // 只处理最顶层的被选图包（嵌套的随祖先一起删）；任何包含目标目录的图包不整包删除。
  const removedFolderRels: string[] = [];
  const keptFolderRels: string[] = [];
  const topFolders = selectedFolders.filter(
    (folder) => !selectedFolders.some((other) => other.id !== folder.id && isRelPrefix(other.relPath, folder.relPath)),
  );
  for (const folder of topFolders) {
    const emptied = imagesOf(snapshot, folder.id).every((image) => movedIds.has(image.id));
    const unsafe = isRelPrefix(folder.relPath, containerRel) || isRelPrefix(folder.relPath, createdRelPath);
    if (!emptied || unsafe) {
      keptFolderRels.push(folder.relPath);
      continue;
    }
    try {
      await deleteLibraryFolder(store, folder.relPath);
      removedFolderRels.push(folder.relPath);
    } catch {
      keptFolderRels.push(folder.relPath);
    }
  }

  const manifest: OrganizeManifest = {
    id: stableHash(`merge-${Date.now()}-${Math.random()}`),
    createdAt: Date.now(),
    containerRelPath: containerRel,
    actions,
  };

  return { manifest, createdRelPath, movedCount: movedIds.size, removedFolderRels, keptFolderRels, conflicts };
}
