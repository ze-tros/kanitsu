/**
 * 桌面端界面共用的小工具、偏好持久化与常量。
 */
import type { FileRef } from '../../../fs-adapter/src/types';
import type { ImageEntry } from '../../../core/src/index';
import type { GalleryLayoutMode } from './galleryLayout';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatModifiedTime(value: number): string {
  if (!value) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

export const formatCount = (n: number): string => n.toLocaleString('zh-CN');

export function imageFileRef(image: ImageEntry): FileRef {
  return {
    id: image.fileRefId ?? image.id,
    name: image.name,
    kind: 'file',
    mtime: image.mtime,
    size: image.size,
    width: image.width,
    height: image.height,
  };
}

export function extLabel(image: ImageEntry): string {
  return image.ext.replace(/^\./, '').toUpperCase().replace('JPEG', 'JPG') || '未知';
}

/** 文件 / 文件夹名的非法字符（Windows 规则，三端统一）。 */
export const ILLEGAL_NAME = /[\\/:*?"<>|]/;

export function validateEntryName(value: string, siblings: readonly string[], current?: string): string {
  const name = value.trim();
  if (!name) return '名称不能为空。';
  if (ILLEGAL_NAME.test(name)) return '不能包含 \\ / : * ? " < > |';
  if (name === '.' || name === '..') return '这个名称不可用。';
  if (name !== current && siblings.includes(name)) return '同级已有同名项目。';
  return '';
}

// —— 视图偏好（本机） ——

export type ImageSort = 'name' | 'modified' | 'size' | 'dims';
export type SortDir = 'asc' | 'desc';
export type PackSort = 'recent' | 'name' | 'count' | 'size';
export type PackView = 'grid' | 'list';
export type LibraryFilter = 'all' | 'recent' | 'pinned';

export const IMAGE_SORT_LABELS: Record<ImageSort, string> = { name: '名称', modified: '修改时间', size: '文件大小', dims: '像素尺寸' };
export const PACK_SORT_LABELS: Record<PackSort, string> = { recent: '最近导入', name: '名称', count: '图片数', size: '占用空间' };

export interface DesktopViewPrefs {
  layout: GalleryLayoutMode;
  /** 网格最小卡片宽 / 按原比例目标行高（px）。 */
  thumbSize: number;
  showNames: boolean;
  includeSubfolders: boolean;
  sort: ImageSort;
  sortDir: SortDir;
  packSort: PackSort;
  packView: PackView;
  /** 图包封面卡片最小宽度（px）。 */
  coverSize: number;
}

export const THUMB_SIZE = { min: 96, max: 320, step: 24, default: 176 } as const;
export const COVER_SIZE = { min: 150, max: 300, step: 24, default: 196 } as const;

const PREFS_KEY = 'kanitsu.desktop.viewPrefs';

const DEFAULT_PREFS: DesktopViewPrefs = {
  layout: 'grid',
  thumbSize: THUMB_SIZE.default,
  showNames: false,
  includeSubfolders: false,
  sort: 'name',
  sortDir: 'asc',
  packSort: 'recent',
  packView: 'grid',
  coverSize: COVER_SIZE.default,
};

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

export function loadViewPrefs(): DesktopViewPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<DesktopViewPrefs>) : {};
    // 旧版只有「网格 / 列表」两种视图，沿用其选择。
    const legacyList = !raw && localStorage.getItem('kanitsu-view-mode') === 'list';
    return {
      layout: p.layout === 'justified' || p.layout === 'list' || p.layout === 'grid' ? p.layout : legacyList ? 'list' : DEFAULT_PREFS.layout,
      thumbSize: clampNum(p.thumbSize, THUMB_SIZE.min, THUMB_SIZE.max, DEFAULT_PREFS.thumbSize),
      showNames: typeof p.showNames === 'boolean' ? p.showNames : DEFAULT_PREFS.showNames,
      includeSubfolders: typeof p.includeSubfolders === 'boolean' ? p.includeSubfolders : DEFAULT_PREFS.includeSubfolders,
      sort: p.sort && p.sort in IMAGE_SORT_LABELS ? p.sort : DEFAULT_PREFS.sort,
      sortDir: p.sortDir === 'desc' ? 'desc' : 'asc',
      packSort: p.packSort && p.packSort in PACK_SORT_LABELS ? p.packSort : DEFAULT_PREFS.packSort,
      packView: p.packView === 'list' ? 'list' : 'grid',
      coverSize: clampNum(p.coverSize, COVER_SIZE.min, COVER_SIZE.max, DEFAULT_PREFS.coverSize),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveViewPrefs(prefs: DesktopViewPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    // 新偏好落盘后旧版的视图键不会再被读取，顺手清掉。
    localStorage.removeItem('kanitsu-view-mode');
  } catch {
    // 偏好只是便利功能，存储失败静默忽略。
  }
}

/** 按当前排序规则排序图片（不修改入参）。 */
export function sortImages(images: readonly ImageEntry[], sort: ImageSort, dir: SortDir): ImageEntry[] {
  const k = dir === 'asc' ? 1 : -1;
  const byName = (a: ImageEntry, b: ImageEntry) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  const cmp: (a: ImageEntry, b: ImageEntry) => number =
    sort === 'size' ? (a, b) => a.size - b.size || byName(a, b)
      : sort === 'modified' ? (a, b) => a.mtime - b.mtime || byName(a, b)
        : sort === 'dims' ? (a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0) || byName(a, b)
          : byName;
  return [...images].sort((a, b) => cmp(a, b) * k);
}

/** 是否运行在 Electron 里：只有这时才有自绘窗口按钮与拖拽区。 */
export const isElectron = (): boolean => window.kanitsuDesktop?.platform === 'electron';
