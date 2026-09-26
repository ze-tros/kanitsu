/**
 * 本机浏览记录，桌面与移动端共用（纯逻辑 + localStorage 持久化，不上传）。
 *
 * - 继续浏览：每个图包记住上次在查看器里停留的图片 id。位置按图片 id 而不是序号
 *   记录，图片被删除、整理到别处后自动失效，不会把用户带到错误的图上。
 * - 导入时间：导入完成时记下顶层图包的时间戳，用于「最近导入」筛选与排序。
 *
 * 键使用 folderId（由 relPath 派生，重扫稳定）；图包被重命名/删除后记录自然失效，
 * 由 prune* 在快照更新时清理。
 */
import type { LibrarySnapshot } from '../../core/src/index';
import { imagesOf } from '../../core/src/index';

export interface RecentBrowseEntry {
  folderId: string;
  imageId: string;
  updatedAt: number;
}

export interface ContinueItem {
  folderId: string;
  imageId: string;
  /** 在图包（含子目录）图片序列中的位置，从 0 开始。 */
  position: number;
  total: number;
}

const RECENT_KEY = 'kanitsu.recentBrowse';
const IMPORTED_KEY = 'kanitsu.importedAt';
/** 继续浏览保留的图包数（首页横向卡片带）。 */
export const RECENT_BROWSE_LIMIT = 6;
/** 「最近导入」筛选的时间窗。 */
export const RECENT_IMPORT_WINDOW_MS = 7 * 24 * 3600 * 1000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 配额满或隐私模式：记录只是便利功能，静默放弃。
  }
}

function isEntry(value: unknown): value is RecentBrowseEntry {
  const e = value as RecentBrowseEntry;
  return !!e && typeof e.folderId === 'string' && typeof e.imageId === 'string' && typeof e.updatedAt === 'number';
}

export function loadRecentBrowse(): RecentBrowseEntry[] {
  const list = readJson<unknown>(RECENT_KEY, []);
  return Array.isArray(list) ? list.filter(isEntry) : [];
}

export function saveRecentBrowse(list: readonly RecentBrowseEntry[]): void {
  writeJson(RECENT_KEY, list);
}

/** 记录一次浏览位置：同一图包只保留最新一条，最新的排最前，超出上限丢弃最旧的。 */
export function recordRecentBrowse(
  list: readonly RecentBrowseEntry[],
  folderId: string,
  imageId: string,
  now = Date.now(),
): RecentBrowseEntry[] {
  const rest = list.filter((e) => e.folderId !== folderId);
  return [{ folderId, imageId, updatedAt: now }, ...rest].slice(0, RECENT_BROWSE_LIMIT);
}

/**
 * 按当前快照解析继续浏览条目：图包或图片已不存在、图片已不在该图包内、或图包只剩
 * 一张图（没有"继续"的意义）的条目被丢弃。返回的列表与 pruned 顺序一致。
 */
export function resolveContinueItems(
  snapshot: LibrarySnapshot,
  list: readonly RecentBrowseEntry[],
): { items: ContinueItem[]; pruned: RecentBrowseEntry[] } {
  const items: ContinueItem[] = [];
  const pruned: RecentBrowseEntry[] = [];
  for (const entry of list) {
    if (entry.folderId === snapshot.rootId || !snapshot.folders[entry.folderId] || !snapshot.images[entry.imageId]) continue;
    const images = imagesOf(snapshot, entry.folderId);
    const position = images.findIndex((img) => img.id === entry.imageId);
    if (position < 0 || images.length < 2) continue;
    items.push({ folderId: entry.folderId, imageId: entry.imageId, position, total: images.length });
    pruned.push(entry);
  }
  return { items, pruned };
}

/** 查看器所在图包：查看列表来自 folderId 本身或其聚合视图时，记在该图包上。 */
export function browseFolderFor(snapshot: LibrarySnapshot, currentFolderId: string, imageId: string): string | null {
  if (!currentFolderId || currentFolderId === snapshot.rootId) {
    // 从根目录（搜索结果等）打开：记在图片所属的顶层图包上。
    const image = snapshot.images[imageId];
    if (!image) return null;
    let folder = snapshot.folders[image.folderId];
    while (folder && folder.parentId && folder.parentId !== snapshot.rootId) folder = snapshot.folders[folder.parentId];
    return folder && folder.id !== snapshot.rootId ? folder.id : null;
  }
  return currentFolderId;
}

export type ImportedAtMap = Record<string, number>;

export function loadImportedAt(): ImportedAtMap {
  const map = readJson<unknown>(IMPORTED_KEY, {});
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  const out: ImportedAtMap = {};
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) if (typeof v === 'number') out[k] = v;
  return out;
}

export function saveImportedAt(map: ImportedAtMap): void {
  writeJson(IMPORTED_KEY, map);
}

/** 丢弃快照里已不存在的图包；无变化时返回原对象（便于调用方跳过写入）。 */
export function pruneImportedAt(snapshot: LibrarySnapshot, map: ImportedAtMap): ImportedAtMap {
  const keys = Object.keys(map);
  const kept = keys.filter((k) => snapshot.folders[k]);
  if (kept.length === keys.length) return map;
  const out: ImportedAtMap = {};
  for (const k of kept) out[k] = map[k]!;
  return out;
}

/** 相对时间（中文）：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / M 月 D 日。 */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  const d = new Date(ts);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startOfToday) return `${Math.floor(diff / hour)} 小时前`;
  const days = Math.ceil((startOfToday - ts) / (24 * hour));
  if (days <= 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
