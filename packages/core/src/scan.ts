import type { FolderRef, LibraryStore } from '../../fs-adapter/src/types';
import type { FolderNode, ImageEntry, LibrarySnapshot } from './types';
import { folderIdFor, imageIdFor } from './hash';
import { extOf, isSupportedImage, joinRelPath } from './path';

export async function scanLibrary(store: LibraryStore): Promise<LibrarySnapshot> {
  const root = await store.getLibraryRoot();
  const folders: Record<string, FolderNode> = {};
  const images: Record<string, ImageEntry> = {};

  async function walk(folder: FolderRef, relPath: string, parentId: string | null): Promise<FolderNode> {
    const folderNode: FolderNode = {
      id: folderIdFor(relPath),
      parentId,
      name: relPath === '' ? root.name : folder.name,
      relPath,
      imageCount: 0,
      directImageCount: 0,
      childCount: 0,
    };
    folders[folderNode.id] = folderNode;

    let directImageCount = 0;
    let childCount = 0;
    let descendantImageCount = 0;

    for await (const child of store.listChildren(folder)) {
      if (child.kind === 'folder') {
        childCount++;
        const childNode = await walk(child, joinRelPath(relPath, child.name), folderNode.id);
        descendantImageCount += childNode.imageCount;
      } else if (isSupportedImage(child.name)) {
        const childRel = joinRelPath(relPath, child.name);
        const image: ImageEntry = {
          id: imageIdFor(childRel),
          folderId: folderNode.id,
          name: child.name,
          relPath: childRel,
          ext: extOf(child.name),
          size: child.size ?? 0,
          mtime: child.mtime ?? 0,
          fileRefId: child.id,
        };
        images[image.id] = image;
        directImageCount++;
      }
    }

    folderNode.directImageCount = directImageCount;
    folderNode.imageCount = directImageCount + descendantImageCount;
    folderNode.childCount = childCount;
    return folderNode;
  }

  await walk(root, '', null);
  const rootId = folderIdFor('');
  return { rootId, folders, images };
}

export function childrenOf(snapshot: LibrarySnapshot, folderId: string): FolderNode[] {
  return Object.values(snapshot.folders).filter((f) => f.parentId === folderId);
}

/** Returns only images directly inside a folder. */
export function directImagesOf(snapshot: LibrarySnapshot, folderId: string): ImageEntry[] {
  return Object.values(snapshot.images)
    .filter((i) => i.folderId === folderId)
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** Returns images of a folder. Parent folders include images from all descendant folders. */
export function imagesOf(snapshot: LibrarySnapshot, folderId: string): ImageEntry[] {
  const direct = directImagesOf(snapshot, folderId);
  const childFolders = childrenOf(snapshot, folderId);
  const nested = childFolders.flatMap((child) => imagesOf(snapshot, child.id));
  return [...direct, ...nested].sort((a, b) => a.relPath.localeCompare(b.relPath));
}