import type { FolderRef, LibraryStore } from '../../fs-adapter/src/types';
import type { FolderNode, ImageEntry, LibrarySnapshot } from './types';
import { folderIdFor, imageIdFor } from './hash';
import { extOf, isHeifImage, isRawImage, isSupportedImage, joinRelPath } from './path';

export interface ScanOptions {
  /**
   * 是否把主流相机 RAW(CR2/CR3/NEF/ARW 等)计入扫描结果。
   * 只有具备 RAW 解码管线的平台(桌面/Android)应开启;web demo 不开启。
   */
  enableRaw?: boolean;
  /**
   * 是否把 HEIF/HEIC 容器(HEIC/HEIF/HIF)计入扫描结果。
   * 同样只有具备专用解码管线的平台(桌面/Android)应开启;web demo 不开启。
   */
  enableHeif?: boolean;
}

export async function scanLibrary(store: LibraryStore, opts?: ScanOptions): Promise<LibrarySnapshot> {
  const enableRaw = opts?.enableRaw ?? false;
  const enableHeif = opts?.enableHeif ?? false;
  const root = await store.getLibraryRoot();
  const fingerprint = await store.getLibraryFingerprint();
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
      } else if (isSupportedImage(child.name) || (enableRaw && isRawImage(child.name)) || (enableHeif && isHeifImage(child.name))) {
        const childRel = joinRelPath(relPath, child.name);
        const image: ImageEntry = {
          id: imageIdFor(childRel),
          folderId: folderNode.id,
          name: child.name,
          relPath: childRel,
          ext: extOf(child.name),
          size: child.size ?? 0,
          mtime: child.mtime ?? 0,
          width: child.width,
          height: child.height,
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
  return { rootId, folders, images, fingerprint, rawScan: enableRaw, heifScan: enableHeif };
}

interface SnapshotLookup {
  childrenByParent: Map<string, FolderNode[]>;
  directImagesByFolder: Map<string, ImageEntry[]>;
  allImagesByFolder: Map<string, ImageEntry[]>;
}

// LibrarySnapshot instances are replaced after every scan/mutation. A WeakMap therefore keeps
// one lookup per live snapshot without requiring explicit invalidation or retaining old libraries.
const snapshotLookups = new WeakMap<LibrarySnapshot, SnapshotLookup>();

function lookupFor(snapshot: LibrarySnapshot): SnapshotLookup {
  const cached = snapshotLookups.get(snapshot);
  if (cached) return cached;

  const lookup: SnapshotLookup = {
    childrenByParent: new Map(),
    directImagesByFolder: new Map(),
    allImagesByFolder: new Map(),
  };
  for (const folder of Object.values(snapshot.folders)) {
    if (folder.parentId === null) continue;
    const siblings = lookup.childrenByParent.get(folder.parentId) ?? [];
    siblings.push(folder);
    lookup.childrenByParent.set(folder.parentId, siblings);
  }
  for (const image of Object.values(snapshot.images)) {
    const direct = lookup.directImagesByFolder.get(image.folderId) ?? [];
    direct.push(image);
    lookup.directImagesByFolder.set(image.folderId, direct);
  }
  for (const images of lookup.directImagesByFolder.values()) {
    images.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }
  snapshotLookups.set(snapshot, lookup);
  return lookup;
}

function indexedImagesOf(
  lookup: SnapshotLookup,
  folderId: string,
  visiting: Set<string>,
): ImageEntry[] {
  const cached = lookup.allImagesByFolder.get(folderId);
  if (cached) return cached;
  if (visiting.has(folderId)) return [];
  visiting.add(folderId);

  const images = [...(lookup.directImagesByFolder.get(folderId) ?? [])];
  for (const child of lookup.childrenByParent.get(folderId) ?? []) {
    images.push(...indexedImagesOf(lookup, child.id, visiting));
  }
  visiting.delete(folderId);
  images.sort((a, b) => a.relPath.localeCompare(b.relPath));
  lookup.allImagesByFolder.set(folderId, images);
  return images;
}

export function childrenOf(snapshot: LibrarySnapshot, folderId: string): FolderNode[] {
  return [...(lookupFor(snapshot).childrenByParent.get(folderId) ?? [])];
}

/** Returns only images directly inside a folder. */
export function directImagesOf(snapshot: LibrarySnapshot, folderId: string): ImageEntry[] {
  return [...(lookupFor(snapshot).directImagesByFolder.get(folderId) ?? [])];
}

/** Returns images of a folder. Parent folders include images from all descendant folders. */
export function imagesOf(snapshot: LibrarySnapshot, folderId: string): ImageEntry[] {
  return [...indexedImagesOf(lookupFor(snapshot), folderId, new Set())];
}
