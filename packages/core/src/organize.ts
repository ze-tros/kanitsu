import type { FileRef, FolderRef, FsEntry, LibraryStore } from '../../fs-adapter/src/types';
import type { LibrarySnapshot, OrganizeBinding } from './types';
import { baseNameOfRelPath, canonicalizeRelPath, joinRelPath, nameKey, normalizeRelPath, parentRelPath } from './path';
import { stableHash } from './hash';
import { resolveFolderRef } from './entry-ops';

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

/** 目标路径的某一段已被同名【文件】占用，无法在其下创建/穿越目录。 */
export class FolderPathBlockedError extends Error {}

/**
 * 解析父目录下名为 `segment` 的子目录；不存在则创建。
 * 与真实平台语义对齐：该名字已被文件占用时抛 FolderPathBlockedError，
 * 而不是把文件当目录继续往下走（各端行为会分裂，memory 端甚至会静默改写节点）。
 * `createdOut` 传入时，记录本次【新建】的目录引用，供调用方回滚空目录。
 */
async function resolveChildFolder(store: LibraryStore, parent: FolderRef, segment: string, createdOut?: FolderRef[]): Promise<FolderRef> {
  for await (const entry of store.listChildren(parent)) {
    if (entry.name !== segment) continue;
    if (entry.kind === 'folder') return { id: entry.id, name: entry.name, kind: 'folder' };
    throw new FolderPathBlockedError(`目标路径被同名文件占用：${segment}`);
  }
  const created = await store.createFolder(parent, segment);
  createdOut?.push(created);
  return created;
}

type FolderCache = Map<string, FolderRef>;
type ChildNameCache = Map<string, Set<string>>;

/** Resolves/creates a folder relative to the library root, memoizing every visited level. */
async function resolveFolderCached(
  store: LibraryStore,
  relPath: string,
  cache: FolderCache,
  createdOut?: FolderRef[],
): Promise<FolderRef> {
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
      child = await resolveChildFolder(store, current, segment, createdOut);
      cache.set(childRel, child);
    }
    current = child;
    currentRel = childRel;
  }
  return current;
}

/**
 * Loads the set of direct child names (files AND folders) in a folder once, keyed by
 * library-relative path. 文件与目录共享同一命名空间：目标目录里已有同名【目录】时
 * 移动图片同样会冲突（真实平台报错，memory 端会静默覆盖整棵子树），必须一起判重。
 */
async function loadChildNames(store: LibraryStore, folderRel: string, folder: FolderRef, cache: ChildNameCache): Promise<Set<string>> {
  let names = cache.get(folderRel);
  if (!names) {
    names = new Set<string>();
    for await (const child of store.listChildren(folder)) {
      names.add(nameKey(child.name));
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

const textEncoder = new TextEncoder();

/** 单段文件名的字节上限（Windows/常见文件系统为 255 字节，留出余量）。 */
const MAX_NAME_BYTES = 240;
/** 为追加序号「 (999)」预留的字节数。 */
const UNIQUE_SUFFIX_BYTES = 12;

export function nextUniqueName(names: Set<string>, name: string): string {
  const dot = name.lastIndexOf('.');
  // 只有「非首字符且不在末尾」的点号才按扩展名分隔：'.jpg' 整名当 stem（隐藏
  // 文件），'x.' 的孤立尾点不当扩展名，避免产出「x (2).」这类畸形名。
  // 多段扩展名(.tar.gz)按最后一个点切分：stem 保留中段、尾部扩展名原样保留，
  // 追加序号后仍是合法的单段文件名。
  const hasExt = dot > 0 && dot < name.length - 1;
  let stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  // 先把基础名压到安全长度，再追加序号：超长名无限追加「 (N)」会越过
  // 文件系统的 255 字节上限导致移动失败。截断按码点进行，避免劈开代理对。
  const stemBudget = MAX_NAME_BYTES - textEncoder.encode(ext).length - UNIQUE_SUFFIX_BYTES;
  while (stemBudget > 0 && textEncoder.encode(stem).length > stemBudget) {
    stem = [...stem].slice(0, -1).join('');
  }
  let i = 2;
  while (names.has(nameKey(`${stem} (${i})${ext}`))) i++;
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
    current = await resolveChildFolder(store, current, segment);
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
  const childNameCache: ChildNameCache = new Map();
  /** 本次调用【新建】的目录（按创建序）：结束后回收仍是空的，避免冲突
   *  被全部跳过时留下预览/撤销都不体现的空文件夹。 */
  const createdFolders: FolderRef[] = [];

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
      const targetFolder = await resolveFolderCached(store, targetFolderRel, folderCache, createdFolders);
      const names = await loadChildNames(store, targetFolderRel, targetFolder, childNameCache);
      let finalName = targetName;
      if (names.has(nameKey(finalName))) {
        if (conflictMode === 'rename') {
          finalName = nextUniqueName(names, finalName);
        } else {
          conflicts.push({ imageId: binding.imageId, name: image.name, targetRelPath: targetAbsRel, reason: 'target-exists' });
          continue;
        }
      }

      const source: FileRef = { id: image.fileRefId, name: image.name, kind: 'file' };
      const moved = await store.move(source, targetFolder, finalName);
      if (parentRelPath(normalizeRelPath(image.relPath)) === targetFolderRel) names.delete(nameKey(image.name));
      names.add(nameKey(moved.kind === 'file' ? moved.name : finalName));
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
        // 目标路径的某一层被同名文件占住：本质是「目标位置已有内容」，归入
        // target-exists 让预览/冲突口径一致，而不是语焉不详的移动失败。
        reason: err instanceof FolderPathBlockedError ? 'target-exists' : 'move-failed',
      });
      void err;
    }
  }

  // 回滚本次新建且仍为空的目录（从深到浅：子目录删掉后父目录才有机会变空；
  // 已装有移动成果的目录自然不会为空，保留）。
  for (const folder of [...createdFolders].reverse()) {
    try {
      let empty = true;
      for await (const child of store.listChildren(folder)) {
        void child;
        empty = false;
        break;
      }
      if (empty) await store.remove(folder);
    } catch {
      // 回滚失败无害：最多多留一个空目录。
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
  const fileRefCache: FileRefCache = new Map();

  for (const action of [...manifest.actions].reverse()) {
    try {
      // 用「不创建目录」的解析：撤销时源目录/目标目录可能已被用户删除，
      // 不能为了查一个不存在的文件而凭空重建整棵目录树（空目录残留）。
      const toFolder = await resolveFolderRef(store, action.toRelPath);
      const toRefs = toFolder ? await loadFileRefs(store, action.toRelPath, toFolder, fileRefCache) : null;
      const source = toRefs?.get(action.toName);
      if (!source) {
        errors.push(`无法还原缺失的文件：${action.toRelPath}/${action.toName}`);
        onProgress?.(undone, total);
        continue;
      }
      const fromFolder = await resolveFolderRef(store, action.fromRelPath);
      const fromRefs = fromFolder ? await loadFileRefs(store, action.fromRelPath, fromFolder, fileRefCache) : null;
      if (fromRefs && fromRefs.has(action.fromName)) {
        errors.push(`目标已存在，跳过还原：${action.fromRelPath}/${action.fromName}`);
        onProgress?.(undone, total);
        continue;
      }
      const target = fromFolder ?? (await ensureFolderRel(store, action.fromRelPath));
      const moved = await store.move(source, target, action.fromName);
      // source 非 null 意味着 toRefs 一定已加载。
      toRefs!.delete(action.toName);
      fromRefs?.set(action.fromName, moved.kind === 'file' ? moved : { id: moved.id, name: moved.name, kind: 'file' });
      undone++;
    } catch (err) {
      errors.push(`撤销失败：${action.toName}：${String(err)}`);
    }
    onProgress?.(undone, total);
  }

  return { undone, errors };
}
