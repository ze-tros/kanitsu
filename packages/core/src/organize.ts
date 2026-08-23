import type { FileRef, FolderRef, FsEntry, LibraryStore } from '../../fs-adapter/src/types';
import type { LibrarySnapshot, OrganizeBinding } from './types';
import { baseNameOfRelPath, joinRelPath, normalizeRelPath, parentRelPath } from './path';
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
}

export interface ApplyOrganizeOptions {
  /** What to do when a file with the target name already exists. Default 'skip'. */
  conflict?: 'skip' | 'rename';
  /** Bindings with confidence below this value are left untouched. Default 0.5. */
  confidenceThreshold?: number;
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

async function findChildFile(store: LibraryStore, folder: FolderRef, name: string): Promise<FileRef | null> {
  for await (const entry of store.listChildren(folder)) {
    if (entry.kind === 'file' && entry.name === name) {
      return { id: entry.id, name: entry.name, kind: 'file', size: entry.size, mtime: entry.mtime };
    }
  }
  return null;
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

async function uniqueFileName(store: LibraryStore, folder: FolderRef, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (await findChildFile(store, folder, `${stem} (${i})${ext}`)) i++;
  return `${stem} (${i})${ext}`;
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
  const containerRel = normalizeRelPath(containerRelPath);

  const actions: OrganizeAction[] = [];
  const conflicts: OrganizeConflict[] = [];
  let appliedCount = 0;
  let skippedLowConfidenceCount = 0;

  for (const binding of bindings) {
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

    const targetAbsRel = joinRelPath(containerRel, normalizeRelPath(binding.virtualPath));
    const targetFolderRel = parentRelPath(targetAbsRel);
    const targetName = baseNameOfRelPath(targetAbsRel);

    // Already in place — nothing to do.
    if (normalizeRelPath(image.relPath) === targetAbsRel) continue;

    try {
      const targetFolder = await ensureFolderRel(store, targetFolderRel);
      let finalName = targetName;
      if (await findChildFile(store, targetFolder, finalName)) {
        if (conflictMode === 'rename') {
          finalName = await uniqueFileName(store, targetFolder, finalName);
        } else {
          conflicts.push({ imageId: binding.imageId, name: image.name, targetRelPath: targetAbsRel, reason: 'target-exists' });
          continue;
        }
      }

      const source: FileRef = { id: image.fileRefId, name: image.name, kind: 'file' };
      const moved = await store.move(source, targetFolder, finalName);
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

  for (const action of [...manifest.actions].reverse()) {
    try {
      const toFolder = await ensureFolderRel(store, action.toRelPath);
      const source = await findChildFile(store, toFolder, action.toName);
      if (!source) {
        errors.push(`Cannot restore missing file: ${action.toRelPath}/${action.toName}`);
        onProgress?.(undone, total);
        continue;
      }
      const fromFolder = await ensureFolderRel(store, action.fromRelPath);
      await store.move(source, fromFolder, action.fromName);
      undone++;
    } catch (err) {
      errors.push(`Undo failed for ${action.toName}: ${String(err)}`);
    }
    onProgress?.(undone, total);
  }

  return { undone, errors };
}
