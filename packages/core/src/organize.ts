import type { FileRef, FolderRef, FsEntry, LibraryStore } from '../../fs-adapter/src/types';
import type { LibrarySnapshot, OrganizeBinding } from './types';
import { baseNameOfRelPath, canonicalizeRelPath, joinRelPath, normalizeRelPath, parentRelPath } from './path';
import { stableHash } from './hash';

/**
 * One concrete file move produced by materializing an organize plan.
 *
 * `fromRelPath` / `toRelPath` are **library-relative** folder paths (`` = library root),
 * so an undo can be performed on any platform implementation of `LibraryStore`.
 */
export interface OrganizeAction {
  fromRelPath: string;
  fromName: string;
  toRelPath: string;
  toName: string;
}

export interface OrganizeConflict {
  imageId: string;
  name: string;
  targetRelPath: string;
  reason: 'source-missing' | 'target-exists' | 'move-failed';
}

export interface OrganizeManifest {
  id: string;
  createdAt: number;
  containerRelPath: string;
  actions: OrganizeAction[];
}

export interface OrganizeResult {
  manifest: OrganizeManifest;
  conflicts: OrganizeConflict[];
  appliedCount: number;
  skippedLowConfidenceCount: number;
  totalEvaluated: number;
  /** 用户主动取消：只返回已处理的文件，后续绑定未执行。 */
  canceled?: boolean;
}

export interface ApplyOrganizeOptions {
  /** What to do when a file with the target name already exists. Default 'skip'. */
  conflict?: 'skip' | 'rename';
  /** Bindings with confidence below this value are left untouched. Default 0.5. */
  confidenceThreshold?: number;
  /** Called with `(processed, total)` as each binding is evaluated. */
  onProgress?: (done: number, total: number) => void;
  /** 返回 true 时停止继续整理，已完成的移动保留。 */
  shouldCancel?: () => boolean;
}

async function listChildrenArray(store: LibraryStore, folder: FolderRef): Promise<FsEntry[]> {
  const out: FsEntry[] = [];
  for await (const entry of store.listChildren(folder)) out.push(entry);
  return out;
}

async function findChildFolder(store: LibraryStore, folder: FolderRef, name: string): Promise<FolderRef | null> {
  for await (const entry of store.listChildren(folder)) {
    if (entry.kind === 'folder' && entry.name === name) return { id: entry.id, name: entry.name, kind: 'folder' };
  }
  return null;
}

type FolderCache = Map<string, FolderRef>;
type FileNameCache = Map<string, Set<string>>;

/** Resolves/creates a folder relative to the library root, memoizing every visited level. */
async function resolveFolderCached(store: LibraryStore, relPath: string, cache: FolderCache): Promise<FolderRef> {
  const normalized = normalizeRelPath(relPath);
  const existing = cache.get(normalized);
  if (existing) return existing;
  const root = await store.getLibraryRoot();
  if (!normalized) {
    cache.set('', root);
    return root;
  }

  const segments = normalized.split('/').filter(Boolean);
  let current = root;
  let currentRel = '';
  for (const segment of segments) {
    const childRel = currentRel ? currentRel + '/' + segment : segment;
    let child: FolderRef | null = cache.get(childRel) ?? null;
    if (!child) {
      child = await findChildFolder(store, current, segment);
      if (!child) child = await store.createFolder(current, segment);
      cache.set(childRel, child);
    }
    current = child;
    currentRel = childRel;
  }
  return current;
}

/** Loads the set of direct file names in a folder once, keyed by library-relative path. */
async function loadFileNames(store: LibraryStore, folderRel: string, folder: FolderRef, cache: FileNameCache): Promise<Set<string>> {
  let names = cache.get(folderRel);
  if (!names) {
    names = new Set<string>();
    for await (const child of store.listChildren(folder)) {
      if (child.kind === 'file') names.add(child.name);
    }
    cache.set(folderRel, names);
  }
  return names;
}

type FileRefCache = Map<string, Map<string, FileRef>>;

/** Loads direct file refs of a folder once, keyed by library-relative path. */
async function loadFileRefs(store: LibraryStore, folderRel: string, folder: FolderRef, cache: FileRefCache): Promise<Map<string, FileRef>> {
  let refs = cache.get(folderRel);
  if (!refs) {
    refs = new Map<string, FileRef>();
    for await (const child of store.listChildren(folder)) {
      if (child.kind === 'file') {
        refs.set(child.name, { id: child.id, name: child.name, kind: 'file', size: child.size, mtime: child.mtime });
      }
    }
    cache.set(folderRel, refs);
  }
  return refs;
}

export function nextUniqueName(names: Set<string>, name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (names.has(`${stem} (${i})${ext}`)) i++;
  return `${stem} (${i})${ext}`;
}

/** Walks from the library root, creating missing folders as it goes. */
export async function ensureFolderRel(store: LibraryStore, relPath: string): Promise<FolderRef> {
  const root = await store.getLibraryRoot();
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return root;
  let current = root;
  for (const segment of normalized.split('/')) {
    if (!segment) continue;
    let child = await findChildFolder(store, current, segment);
    if (!child) child = await store.createFolder(current, segment);
    current = child;
  }
  return current;
}

/**
 * Materializes an organize plan: moves files inside the app-owned library into the
 * tree described by the bindings, creating folders, detecting conflicts, and recording
 * a reversible manifest.
 *
 * Targets are resolved **relative to `containerRelPath`** (the library-relative folder the
 * user is organizing, `` for the library root). The source file that currently lives in
 * the container subtree is re-located to `<containerRelPath>/<binding.virtualPath>`.
 */
export async function applyOrganize(
  store: LibraryStore,
  snapshot: LibrarySnapshot,
  containerRelPath: string,
  bindings: OrganizeBinding[],
  options: ApplyOrganizeOptions = {},
): Promise<OrganizeResult> {
  const conflictMode = options.conflict ?? 'skip';
  const threshold = options.confidenceThreshold ?? 0.5;
  const containerRel = canonicalizeRelPath(containerRelPath);

  // Memoize folder resolution and target-folder file names across bindings so we
  // avoid re-walking/re-listing the same directories for every file. This is the
  // dominant cost for large libraries (previously O(files × depth) directory scans).
  const folderCache: FolderCache = new Map();
  const fileNameCache: FileNameCache = new Map();

  const actions: OrganizeAction[] = [];
  const conflicts: OrganizeConflict[] = [];
  let appliedCount = 0;
  let skippedLowConfidenceCount = 0;
  let cancelled = false;
  const total = bindings.length;
  let processed = 0;
  options.onProgress?.(0, total);

  for (const binding of bindings) {
    if (options.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    processed++;
    options.onProgress?.(processed, total);
    if (binding.confidence < threshold) {
      skippedLowConfidenceCount++;
      continue;
    }

    const image = snapshot.images[binding.imageId];
    if (!image || !image.fileRefId) {
      conflicts.push({
        imageId: binding.imageId,
        name: image?.name ?? binding.imageId,
        targetRelPath: binding.virtualPath,
        reason: 'source-missing',
      });
      continue;
    }

    let targetAbsRel: string;
    try {
      targetAbsRel = joinRelPath(containerRel, canonicalizeRelPath(binding.virtualPath));
    } catch {
      conflicts.push({
        imageId: binding.imageId,
        name: image.name,
        targetRelPath: binding.virtualPath,
        reason: 'move-failed',
      });
      continue;
    }
    const targetFolderRel = parentRelPath(targetAbsRel);
    const targetName = baseNameOfRelPath(targetAbsRel);

    // Already in place — nothing to do.
    if (normalizeRelPath(image.relPath) === targetAbsRel) continue;

    try {
      const targetFolder = await resolveFolderCached(store, targetFolderRel, folderCache);
      const names = await loadFileNames(store, targetFolderRel, targetFolder, fileNameCache);
      let finalName = targetName;
      if (names.has(finalName)) {
        if (conflictMode === 'rename') {
          finalName = nextUniqueName(names, finalName);
        } else {
          conflicts.push({ imageId: binding.imageId, name: image.name, targetRelPath: targetAbsRel, reason: 'target-exists' });
          continue;
        }
      }

      const source: FileRef = { id: image.fileRefId, name: image.name, kind: 'file' };
      const moved = await store.move(source, targetFolder, finalName);
      if (parentRelPath(normalizeRelPath(image.relPath)) === targetFolderRel) names.delete(image.name);
      names.add(moved.kind === 'file' ? moved.name : finalName);
      actions.push({
        fromRelPath: parentRelPath(normalizeRelPath(image.relPath)),
        fromName: image.name,
        toRelPath: targetFolderRel,
        toName: moved.kind === 'file' ? moved.name : finalName,
      });
      appliedCount++;
    } catch (err) {
      conflicts.push({
        imageId: binding.imageId,
        name: image.name,
        targetRelPath: targetAbsRel,
        reason: 'move-failed',
      });
      void err;
    }
  }

  const manifest: OrganizeManifest = {
    id: stableHash(`organize-${Date.now()}-${Math.random()}`),
    createdAt: Date.now(),
    containerRelPath: containerRel,
    actions,
  };

  return {
    manifest,
    conflicts,
    appliedCount,
    skippedLowConfidenceCount,
    totalEvaluated: bindings.length,
    canceled: cancelled,
  };
}

export interface UndoOrganizeResult {
  undone: number;
  errors: string[];
}

/** Reverses every move in a manifest (in reverse order). */
export async function undoOrganize(
  store: LibraryStore,
  manifest: OrganizeManifest,
  onProgress?: (done: number, total: number) => void,
): Promise<UndoOrganizeResult> {
  const errors: string[] = [];
  let undone = 0;
  const total = manifest.actions.length;
  const folderCache: FolderCache = new Map();
  const fileRefCache: FileRefCache = new Map();

  for (const action of [...manifest.actions].reverse()) {
    try {
      const toFolder = await resolveFolderCached(store, action.toRelPath, folderCache);
      const toRefs = await loadFileRefs(store, action.toRelPath, toFolder, fileRefCache);
      const source = toRefs.get(action.toName);
      if (!source) {
        errors.push(`无法还原缺失的文件：${action.toRelPath}/${action.toName}`);
        onProgress?.(undone, total);
        continue;
      }
      const fromFolder = await resolveFolderCached(store, action.fromRelPath, folderCache);
      const fromRefs = await loadFileRefs(store, action.fromRelPath, fromFolder, fileRefCache);
      if (fromRefs.has(action.fromName)) {
        errors.push(`目标已存在，跳过还原：${action.fromRelPath}/${action.fromName}`);
        onProgress?.(undone, total);
        continue;
      }
      const moved = await store.move(source, fromFolder, action.fromName);
      toRefs.delete(action.toName);
      fromRefs.set(action.fromName, moved.kind === 'file' ? moved : { id: moved.id, name: moved.name, kind: 'file' });
      undone++;
    } catch (err) {
      errors.push(`撤销失败：${action.toName}：${String(err)}`);
    }
    onProgress?.(undone, total);
  }

  return { undone, errors };
}
