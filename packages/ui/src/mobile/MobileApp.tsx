import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  applyOrganize,
  childrenOf,
  createSubfolder,
  deleteImage,
  deleteLibraryFolder,
  directImagesOf,
  imagesOf,
  importFolder,
  loadOrScan,
  renameFolder,
  renameImage,
  rescanLibrary,
  undoOrganize,
  type FolderNode,
  type ImageEntry,
  type LibrarySnapshot,
  type OrganizeBinding,
  type OrganizeManifest,
  type PersistentIndex,
} from '../../../core/src/index';
import type { FileRef, ImportSourcePicker, LibraryStore } from '../../../fs-adapter/src/types';
import type { CustomOrganizeRule } from '../../../organizer/src/index';
import { pickCover } from '../../../cover-picker/src/index';
import { BlobImage } from '../BlobImage';
import {
  COVER_THUMBNAIL_SIZE,
  preloadThumbnails,
  setThumbnailPreloadPaused,
  THUMB_PRIORITY_CURRENT_DIR,
  THUMB_PRIORITY_SUBFOLDER,
  THUMB_PRIORITY_WARMUP,
} from '../thumbnailCache';
import { isPrefetchEnabled } from '../debugLog';
import { loadCustomRules, saveCustomRules } from '../OrganizeRulesModal';
import { CoverPickerModal } from '../CoverPickerModal';
import { MobileViewer } from './MobileViewer';
import {
  MobileActionSheet,
  MobileConfirmDialog,
  MobilePromptDialog,
  MobileToast,
  type SheetAction,
  type ToastAction,
} from './MobileSheets';
import { MobileSettingsScreen, type SettingsSectionId } from './MobileSettingsScreen';
import { useExitPresence } from './useExitPresence';
import {
  FOLDER_GRID,
  IMAGE_GRID,
  clearRecentSearches,
  formatBytes,
  haptic,
  imageGridGap,
  isImageBlurred,
  loadBlurredImages,
  loadImageGridCols,
  loadLibraryPrefs,
  loadPinnedCovers,
  loadRecentSearches,
  pushRecentSearch,
  saveBlurredImages,
  saveImageGridCols,
  saveLibraryPrefs,
  savePinnedCovers,
  startThemeModeSync,
  type LibraryPrefs,
} from './mobileShared';
import { Z_BATCH_BAR, Z_DIALOG } from './zindex';
import { MobileIcon } from './mobileIcons';
import {
  ContinueCard,
  ImageCard,
  ImageListRow,
  PackCard,
  PackRow,
  RowGrid,
  SubfolderCard,
  imageToFileRef,
} from './mobileCards';
import { ProgressPill, TaskButton, TasksScreen, type MobileTask } from './MobileTasks';
import { MobileOrganizeFlow } from './MobileOrganizeFlow';
import { DisplaySheet, FolderTreeSheet, LibrarySortSheet, type SortDirection, type SortMode } from './MobileDisplaySheets';
import {
  RECENT_IMPORT_WINDOW_MS,
  browseFolderFor,
  formatRelativeTime,
  loadImportedAt,
  loadRecentBrowse,
  pruneImportedAt,
  recordRecentBrowse,
  resolveContinueItems,
  saveImportedAt,
  saveRecentBrowse,
  type ImportedAtMap,
  type RecentBrowseEntry,
} from './browseHistory';
import { closeOverlayEntries, reconcilePop, type OverlayLayer, type StackEntry } from './historyStack';

const MOBILE_SCROLL_PRELOAD_RESUME_MS = 180;
/** 顶栏由透明转为实底的滚动阈值（图库首页 / 图包页封面页头）。 */
const APPBAR_SOLID_AT_ROOT = 64;
const APPBAR_SOLID_AT_FOLDER = 220;
/** 捏合改变列数的缩放比阈值（每越过一次改变一列）。 */
const PINCH_STEP_RATIO = 1.28;
/** 拖动连选时手指靠近滚动区上下沿的自动滚动触发距离与最大速度。 */
const DRAG_EDGE = 90;
const DRAG_MAX_SPEED = 18;

type DeleteTarget =
  | { kind: 'image'; image: ImageEntry }
  | { kind: 'folder'; folder: FolderNode }
  | { kind: 'batch'; count: number };

type PromptState =
  | { kind: 'rename-image'; image: ImageEntry }
  | { kind: 'rename-folder'; folder: FolderNode }
  | { kind: 'create-folder'; folder: FolderNode }
  | { kind: 'batch-move'; count: number };

interface SheetModel {
  title?: string;
  subtitle?: string;
  media?: ImageEntry;
  quickActions?: SheetAction[];
  actions: SheetAction[];
}

type DisplaySheetKind = 'images' | 'library';
type LibraryFilter = 'all' | 'recent' | 'pinned';

interface ToastState {
  text: string;
  kind: 'info' | 'success' | 'error';
  action?: ToastAction;
}

let taskSeq = 0;

export function MobileApp({
  picker,
  store,
  index,
  enableRaw,
  enableHeif,
}: {
  picker: ImportSourcePicker;
  store: LibraryStore;
  index: PersistentIndex;
  /** 是否收录主流相机 RAW(Android 开启;解码在 WebView 内完成)。 */
  enableRaw?: boolean;
  /** 是否收录 HEIF/HEIC 容器(Android 开启;缩略图/查看由原生解码)。 */
  enableHeif?: boolean;
}) {
  useEffect(() => startThemeModeSync(), []);

  // ===== 数据状态 =====
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [viewerSessionId, setViewerSessionId] = useState(0);
  const [viewerInfoOpen, setViewerInfoOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());
  const [blurredImages, setBlurredImages] = useState<ReadonlySet<string>>(() => loadBlurredImages());
  const [pinnedCovers, setPinnedCovers] = useState<Record<string, string>>(() => loadPinnedCovers());
  const [customRules, setCustomRules] = useState<CustomOrganizeRule[]>(() => loadCustomRules());
  const [showFileNames, setShowFileNames] = useState<boolean>(() => localStorage.getItem('kanitsu.showFileNames') === '1');
  const [sortMode, setSortMode] = useState<SortMode>('default');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  /** 包含子目录聚合视图（DESIGN.md 4.3）：图片区显示当前目录及其所有子目录的图片。 */
  const [aggregate, setAggregate] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => (localStorage.getItem('kanitsu.viewMode') === 'list' ? 'list' : 'grid'));
  const [gridCols, setGridCols] = useState(() => loadImageGridCols());
  const [libPrefs, setLibPrefs] = useState<LibraryPrefs>(() => loadLibraryPrefs());
  const [libFilter, setLibFilter] = useState<LibraryFilter>('all');
  // 本机浏览记录：继续浏览 + 导入时间（见 browseHistory）。
  const [recentBrowse, setRecentBrowse] = useState<RecentBrowseEntry[]>(() => loadRecentBrowse());
  const [importedAt, setImportedAt] = useState<ImportedAtMap>(() => loadImportedAt());
  const [recentSearches, setRecentSearches] = useState<string[]>(() => loadRecentSearches());

  // ===== UI 层状态 =====
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [displaySheet, setDisplaySheet] = useState<DisplaySheetKind | null>(null);
  const [searchActive, setSearchActive] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sheet, setSheet] = useState<SheetModel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [coverPickerFolder, setCoverPickerFolder] = useState<FolderNode | null>(null);
  // 设置页与页内分类详情（二级）。section 由本层持有，硬件返回时先退详情，再关设置页。
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const [tasksUnseen, setTasksUnseen] = useState(false);
  // 多选 / 批量操作
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [organizeFlow, setOrganizeFlow] = useState<{ folder: FolderNode; step: 1 | 2 } | null>(null);
  const [lastManifest, setLastManifest] = useState<{ taskId: string; manifest: OrganizeManifest } | null>(null);
  // 顶栏实底与 FAB 收缩只在越过阈值时更新，不随滚动逐帧 setState。
  const [appbarSolid, setAppbarSolid] = useState(false);
  const [fabCompact, setFabCompact] = useState(false);

  // ===== 关闭退场动画：这些层关闭时多挂载一小段时间播放滑出/淡出 =====
  const settingsPresence = useExitPresence(showSettings, 240);
  const tasksPresence = useExitPresence(showTasks, 240);
  const dialogPresence = useExitPresence(deleteTarget != null || promptState != null, 200);
  const organizePresence = useExitPresence(organizeFlow != null, 240);
  const coverPresence = useExitPresence(coverPickerFolder != null, 200);
  // 退场动画期间数据已被置空，用 ref 保留最后一次的内容供退出渲染。
  const organizeFlowRef = useRef(organizeFlow);
  organizeFlowRef.current = organizeFlow ?? organizeFlowRef.current;
  const coverFolderRef = useRef(coverPickerFolder);
  coverFolderRef.current = coverPickerFolder ?? coverFolderRef.current;
  // 对话框退场同理：ref 保留最后一份内容（打开另一种对话框时清对方的 ref，避免串内容）。
  const deleteTargetRef = useRef(deleteTarget);
  deleteTargetRef.current = deleteTarget ?? deleteTargetRef.current;
  const promptStateRef = useRef(promptState);
  promptStateRef.current = promptState ?? promptStateRef.current;

  // ===== 任务 =====
  const [tasks, setTasks] = useState<MobileTask[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // 键盘态：输入框聚焦时隐藏底部浮动栏，避免被键盘顶到半空悬浮。
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // 任务取消句柄：导入/导出用 token（原生 cancelTask），整理用 JS 侧标志。
  const taskCancelRef = useRef(new Map<string, () => void>());
  const importingRef = useRef(false);
  const exportingRef = useRef(false);
  const organizingRef = useRef(false);

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const selectedFolderIdRef = useRef(selectedFolderId);
  selectedFolderIdRef.current = selectedFolderId;
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  const settingsSectionRef = useRef(settingsSection);
  settingsSectionRef.current = settingsSection;
  const viewerInfoOpenRef = useRef(viewerInfoOpen);
  viewerInfoOpenRef.current = viewerInfoOpen;
  const organizeStepRef = useRef(organizeFlow?.step ?? 1);
  organizeStepRef.current = organizeFlow?.step ?? 1;
  const showTasksRef = useRef(showTasks);
  showTasksRef.current = showTasks;

  const importing = tasks.some((t) => t.kind === 'import' && t.status === 'running');
  const organizing = tasks.some((t) => t.kind === 'organize' && t.status === 'running');
  const exporting = tasks.some((t) => t.kind === 'export' && t.status === 'running');
  const batchBusy = tasks.some((t) => (t.kind === 'delete' || t.kind === 'move') && t.status === 'running');

  // 搜索防抖：输入停止 180ms 后才更新查询，避免每击一键重算数千张图的过滤。
  useEffect(() => {
    const t = window.setTimeout(() => setSearchQuery(searchInput.trim()), 180);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const applySnapshot = useCallback((next: LibrarySnapshot) => {
    setSnapshot(next);
    setSelectedFolderId((prev) => {
      const folderId = prev && next.folders[prev] ? prev : next.rootId;
      selectedFolderIdRef.current = folderId;
      return folderId;
    });
  }, []);

  // ===== 启动加载（失败进入错误态并可重试，不再只剩死转圈） =====
  const loadLibrary = useCallback(async () => {
    setLoadError(null);
    try {
      applySnapshot(await loadOrScan(store, index, { enableRaw: enableRaw ?? false, enableHeif: enableHeif ?? false }));
    } catch (err) {
      setLoadError(String(err));
    }
  }, [store, index, applySnapshot, enableRaw, enableHeif]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const refresh = useCallback(async () => {
    const next = await rescanLibrary(store, index, { enableRaw: enableRaw ?? false, enableHeif: enableHeif ?? false });
    applySnapshot(next);
    return next;
  }, [store, index, applySnapshot, enableRaw, enableHeif]);

  // Snackbar 自动消失（带动作的停留更久，留出点按时间）。
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toast.action ? 5200 : 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  // 键盘态检测：输入框聚焦 + 视口被键盘压缩（adjustResize 压布局视口、
  // adjustPan/Nothing 压可视层）才置真。旋转屏幕时可能短暂误判，可接受。
  useEffect(() => {
    const vv = window.visualViewport;
    let maxInnerHeight = window.innerHeight;
    const inputFocusedRef = { current: false as boolean };
    const recompute = (): void => {
      const shrunkLayout = window.innerHeight < maxInnerHeight - 120;
      const shrunkVisual = vv ? vv.height < window.innerHeight - 120 : false;
      maxInnerHeight = Math.max(maxInnerHeight, window.innerHeight);
      setKeyboardOpen(inputFocusedRef.current && (shrunkLayout || shrunkVisual));
    };
    const isTextField = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const onFocusIn = (e: FocusEvent): void => {
      if (!isTextField(e.target)) return;
      inputFocusedRef.current = true;
      recompute();
      // 键盘弹出动画晚于 focus，稍后再判一次。
      window.setTimeout(recompute, 120);
    };
    const onFocusOut = (): void => {
      inputFocusedRef.current = false;
      window.setTimeout(recompute, 120);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    vv?.addEventListener('resize', recompute);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      vv?.removeEventListener('resize', recompute);
    };
  }, []);

  const notify = useCallback((text: string, kind?: ToastState['kind'], action?: ToastAction) => {
    const detected = kind ?? (/失败|错误/.test(text) ? 'error' : /完成|成功|^已/.test(text) ? 'success' : 'info');
    setToast({ text, kind: detected, action });
  }, []);

  // ===== 任务记录 =====
  const startTask = useCallback((task: Pick<MobileTask, 'kind' | 'title'> & Partial<MobileTask>): string => {
    const id = `task-${Date.now()}-${++taskSeq}`;
    setTasks((prev) => [{ id, status: 'running', done: 0, total: 0, startedAt: Date.now(), ...task }, ...prev]);
    return id;
  }, []);

  const patchTask = useCallback((id: string, patch: Partial<MobileTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const finishTask = useCallback((id: string, status: MobileTask['status'], patch: Partial<MobileTask> = {}) => {
    taskCancelRef.current.delete(id);
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch, status, cancelable: false, finishedAt: Date.now() } : t)));
    if (!showTasksRef.current) setTasksUnseen(true);
  }, []);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
      notify('已重新扫描图库', 'success');
    } catch (err) {
      notify(`刷新失败：${String(err)}`, 'error');
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, refresh, notify]);

  // ===== 派生数据 =====
  const currentFolderId = selectedFolderId || snapshot?.rootId || '';
  const selectedFolder = snapshot?.folders[currentFolderId] ?? null;
  const rootFolder = snapshot ? snapshot.folders[snapshot.rootId] : null;
  const isRoot = !selectedFolderId || selectedFolderId === snapshot?.rootId;
  const libraryStats = useMemo(() => {
    if (!snapshot) return { imageCount: 0, bytes: 0 };
    const images = Object.values(snapshot.images);
    return { imageCount: images.length, bytes: images.reduce((total, image) => total + (image.size ?? 0), 0) };
  }, [snapshot]);

  /** 每个目录（含子目录）的占用与最近修改时间：图包排序、副标题与页头统计共用。 */
  const folderStats = useMemo(() => {
    const stats = new Map<string, { bytes: number; latest: number }>();
    if (!snapshot) return stats;
    for (const image of Object.values(snapshot.images)) {
      let folder: FolderNode | undefined = snapshot.folders[image.folderId];
      while (folder) {
        const s = stats.get(folder.id) ?? { bytes: 0, latest: 0 };
        s.bytes += image.size ?? 0;
        s.latest = Math.max(s.latest, image.mtime ?? 0);
        stats.set(folder.id, s);
        folder = folder.parentId ? snapshot.folders[folder.parentId] : undefined;
      }
    }
    return stats;
  }, [snapshot]);

  // 快照变化后清理失效的浏览记录与导入时间（图包被删/改名、图片被删/整理走）。
  const continueResolved = useMemo(
    () => (snapshot ? resolveContinueItems(snapshot, recentBrowse) : { items: [], pruned: recentBrowse }),
    [snapshot, recentBrowse],
  );
  useEffect(() => {
    if (!snapshot) return;
    if (continueResolved.pruned.length !== recentBrowse.length) {
      setRecentBrowse(continueResolved.pruned);
      saveRecentBrowse(continueResolved.pruned);
    }
    const prunedImported = pruneImportedAt(snapshot, importedAt);
    if (prunedImported !== importedAt) {
      setImportedAt(prunedImported);
      saveImportedAt(prunedImported);
    }
  }, [snapshot, continueResolved, recentBrowse, importedAt]);

  const searchTerm = searchQuery.trim().toLowerCase();
  const sortImages = useCallback(
    (images: ImageEntry[]): ImageEntry[] => {
      if (sortMode === 'default') return images;
      const sorted = [...images];
      const direction = sortDirection === 'asc' ? 1 : -1;
      if (sortMode === 'name') sorted.sort((a, b) => direction * a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      else if (sortMode === 'date') sorted.sort((a, b) => direction * ((a.mtime ?? 0) - (b.mtime ?? 0)));
      else sorted.sort((a, b) => direction * ((a.size ?? 0) - (b.size ?? 0)));
      return sorted;
    },
    [sortMode, sortDirection],
  );

  const folderImages = useMemo(() => {
    if (!snapshot) return [];
    return sortImages(directImagesOf(snapshot, currentFolderId));
  }, [snapshot, currentFolderId, sortImages]);

  // 聚合视图：当前目录 + 所有子目录的图片（imagesOf 递归收集）。
  const aggregateImages = useMemo(() => {
    if (!snapshot || !aggregate) return [];
    return sortImages(imagesOf(snapshot, currentFolderId));
  }, [snapshot, currentFolderId, aggregate, sortImages]);

  const coverFor = useCallback(
    (folderId: string): ImageEntry | undefined => {
      if (!snapshot) return undefined;
      const cover = pickCover(imagesOf(snapshot, folderId), { preferredId: pinnedCovers[folderId] });
      return cover ? snapshot.images[cover.imageId] : undefined;
    },
    [snapshot, pinnedCovers],
  );

  const childFolders = useMemo(() => {
    if (!snapshot) return [];
    const folders = childrenOf(snapshot, currentFolderId);
    if (sortMode === 'default') return folders;
    const direction = sortDirection === 'asc' ? 1 : -1;
    if (sortMode === 'name') return [...folders].sort((a, b) => direction * a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    return [...folders].sort((a, b) => {
      const sa = folderStats.get(a.id);
      const sb = folderStats.get(b.id);
      return sortMode === 'size'
        ? direction * ((sa?.bytes ?? 0) - (sb?.bytes ?? 0))
        : direction * ((sa?.latest ?? 0) - (sb?.latest ?? 0));
    });
  }, [snapshot, currentFolderId, sortMode, sortDirection, folderStats]);

  /** 图库首页的图包：筛选（全部 / 最近导入 / 已固定）+ 排序（图库排列偏好）。 */
  const libraryPacks = useMemo(() => {
    if (!snapshot) return [];
    let packs = childrenOf(snapshot, snapshot.rootId);
    const now = Date.now();
    if (libFilter === 'recent') packs = packs.filter((f) => (importedAt[f.id] ?? 0) > now - RECENT_IMPORT_WINDOW_MS);
    if (libFilter === 'pinned') packs = packs.filter((f) => pinnedCovers[f.id] != null);
    const recency = (f: FolderNode) => importedAt[f.id] ?? folderStats.get(f.id)?.latest ?? 0;
    const sorted = [...packs];
    if (libPrefs.sort === 'recent') sorted.sort((a, b) => recency(b) - recency(a));
    else if (libPrefs.sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    else if (libPrefs.sort === 'count') sorted.sort((a, b) => b.imageCount - a.imageCount);
    else sorted.sort((a, b) => (folderStats.get(b.id)?.bytes ?? 0) - (folderStats.get(a.id)?.bytes ?? 0));
    return sorted;
  }, [snapshot, libFilter, libPrefs.sort, importedAt, pinnedCovers, folderStats]);

  const packSubtitle = useCallback(
    (folder: FolderNode): string => {
      const parts: string[] = [];
      if (folder.childCount > 0) parts.push(`${folder.childCount} 个子目录`);
      const imported = importedAt[folder.id];
      if (imported) parts.push(formatRelativeTime(imported));
      else parts.push(formatBytes(folderStats.get(folder.id)?.bytes ?? 0));
      return parts.join(' · ');
    },
    [importedAt, folderStats],
  );

  // —— 全局搜索（跨图包）——
  const searching = searchActive && searchTerm.length > 0;
  const searchImages = useMemo(() => {
    if (!snapshot || !searchTerm) return [];
    return Object.values(snapshot.images).filter((img) => img.name.toLowerCase().includes(searchTerm));
  }, [snapshot, searchTerm]);
  const searchFolders = useMemo(() => {
    if (!snapshot || !searchTerm) return [];
    return Object.values(snapshot.folders)
      .filter((f) => f.id !== snapshot.rootId && f.name.toLowerCase().includes(searchTerm))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  }, [snapshot, searchTerm]);
  /** 搜索页的格式快捷词：图库里出现最多的扩展名。 */
  const formatChips = useMemo(() => {
    if (!snapshot || !searchActive) return [];
    const counts = new Map<string, number>();
    for (const img of Object.values(snapshot.images)) counts.set(img.ext.toLowerCase(), (counts.get(img.ext.toLowerCase()) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([ext]) => `.${ext.replace(/^\./, '')}`);
  }, [snapshot, searchActive]);

  /** 实际显示的图片列表：聚合 > 当前目录；搜索中查看器用搜索结果。 */
  const displayImages = aggregate ? aggregateImages : folderImages;
  const viewerImages = searching ? searchImages : displayImages;
  const viewerIndex = viewerImageId ? viewerImages.findIndex((img) => img.id === viewerImageId) : -1;
  const viewerOpen = viewerImageId != null && viewerIndex >= 0;
  const pageKind: 'search' | 'library' | 'folder' = searchActive ? 'search' : isRoot ? 'library' : 'folder';

  // ===== 返回键混合栈（folder 导航 + overlay 层）=====
  // 以 history.state 中的栈快照为唯一权威：目录导航使用 pushState，overlay
  // 使用 replaceState 写入当前快照，不制造额外的浏览器历史项。popstate
  // 按快照对账（差量关闭 overlay / 回退文件夹），不再用 consumedPops 计数器——
  // 它是快速连续返回 / 主动关闭与硬件返回交错时栈错乱的竞态根源。
  const stackRef = useRef<StackEntry[]>([]);
  const mainScrollRef = useRef<HTMLDivElement>(null);

  // ===== 页面切换动画 =====
  // 目录前进/后退、搜索开合时对滚动容器重放入场动画（方向感知）。动画放在
  // 视口大小的滚动容器上，而不是内容包装层——后者在万级图目录下可达几十万
  // px 高，整体提升为合成层的内存/栅格化代价不可控。
  const [pageTransition, setPageTransition] = useState<{ seq: number; kind: 'forward' | 'back' }>({ seq: 0, kind: 'forward' });
  const animatePage = useCallback((kind: 'forward' | 'back') => {
    setPageTransition((prev) => ({ seq: prev.seq + 1, kind }));
  }, []);

  useLayoutEffect(() => {
    const el = mainScrollRef.current;
    if (!el || pageTransition.seq === 0) return;
    el.classList.remove('m-page-in', 'is-back');
    if (pageTransition.kind === 'back') el.classList.add('is-back');
    // 读取 offsetWidth 强制 reflow：同名类连续两次前进导航也要重播动画。
    void el.offsetWidth;
    el.classList.add('m-page-in');
    // animationend 会从子元素冒泡上来（占位 shimmer 等），只认自己的。
    const done = (e: AnimationEvent) => {
      if (e.target !== el) return;
      el.classList.remove('m-page-in', 'is-back');
    };
    el.addEventListener('animationend', done);
    return () => el.removeEventListener('animationend', done);
  }, [pageTransition]);

  const readStackSnapshot = useCallback((): StackEntry[] => {
    const s = window.history.state as { kanitsuStack?: unknown } | null;
    return Array.isArray(s?.kanitsuStack) ? (s.kanitsuStack as StackEntry[]) : [];
  }, []);

  const closeOverlayUI = useCallback(
    (layer: OverlayLayer) => {
      switch (layer) {
        case 'drawer':
          setDrawerOpen(false);
          break;
        case 'display':
          setDisplaySheet(null);
          break;
        case 'sheet':
          setSheet(null);
          break;
        case 'viewer':
          setViewerImageId(null);
          setViewerInfoOpen(false);
          break;
        case 'settings':
          // 不在此处重置 settingsSection：退场动画期间页面要保持原内容，
          // 下次 openSettings 时会重置。
          setShowSettings(false);
          break;
        case 'tasks':
          setShowTasks(false);
          break;
        case 'organize':
          setOrganizeFlow(null);
          break;
        case 'cover':
          setCoverPickerFolder(null);
          break;
        case 'dialog':
          setDeleteTarget(null);
          setPromptState(null);
          break;
        case 'search':
          setSearchActive(false);
          setSearchQuery('');
          setSearchInput('');
          animatePage('back');
          break;
      }
    },
    [animatePage],
  );

  useEffect(() => {
    const onPop = () => {
      const target = readStackSnapshot();
      // 对账细节见 historyStack.reconcilePop：快照一致=主动关闭触发的 back()，忽略。
      const res = reconcilePop(stackRef.current, target);
      if (!res.changed) return;
      stackRef.current = target;
      for (const layer of res.closed) closeOverlayUI(layer);
      const folderId = res.folderId ?? snapshotRef.current?.rootId ?? '';
      // 只在目录真正回退时播返回动画；仅关闭浮层（面板）不闪内容区。
      if (folderId !== selectedFolderIdRef.current) {
        animatePage('back');
        setSelectMode(false);
        setSelectedIds(new Set());
      }
      selectedFolderIdRef.current = folderId;
      setSelectedFolderId(folderId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [closeOverlayUI, readStackSnapshot, animatePage]);

  const openOverlay = useCallback((layer: OverlayLayer) => {
    // 同一 UI 层只能存在一次。快速双击或 WebView 合成重复 click 时，重复入栈会
    // 产生肉眼不可见的 phantom overlay，导致返回键看似“失效”。
    if (stackRef.current.some((entry) => entry.type === 'overlay' && entry.layer === layer)) return;
    const next: StackEntry[] = [...stackRef.current, { type: 'overlay', layer }];
    stackRef.current = next;
    // Overlay 不是页面导航：原地更新快照，避免主动关闭后留下重复 history entry。
    window.history.replaceState({ kanitsuStack: next }, '');
  }, []);

  /**
   * 主动关闭某 overlay：原地替换当前 history state。
   *
   * Overlay 本身不创建 history entry，因此关闭时只需同步更新快照；这也让动作面板
   * 关闭动画结束后打开的新层不会与异步 history.go() 发生竞态。
   */
  const closeOverlay = useCallback(
    (layer: OverlayLayer) => {
      const prev = stackRef.current;
      const { stack: next, closed } = closeOverlayEntries(prev, layer);
      stackRef.current = next;
      for (const l of closed) closeOverlayUI(l);
      // 条目真实存在过才回写快照（关闭一个已关闭的层是幂等操作，不动 history）。
      if (next !== prev) window.history.replaceState({ kanitsuStack: next }, '');
    },
    [closeOverlayUI],
  );

  // 查看器可能不走 closeOverlay('viewer') 就消失（如删除当前图后 viewerIndex 变 -1），
  // 此时栈里残留幽灵 viewer 条目、下一次硬件返回被吞。统一兜底裁掉。
  useEffect(() => {
    if (viewerOpen) return;
    if (stackRef.current.some((e) => e.type === 'overlay' && e.layer === 'viewer')) closeOverlay('viewer');
  }, [viewerOpen, closeOverlay]);

  // Android hardware back is routed here by MainActivity. Keeping the event
  // cancelable lets the native layer distinguish "close the current UI layer"
  // from "leave the app" without duplicating the navigation stack in Java.
  useEffect(() => {
    const onAndroidBack = (event: Event) => {
      const top = stackRef.current[stackRef.current.length - 1];
      if (top?.type === 'overlay') {
        event.preventDefault();
        if (top.layer === 'settings' && settingsSectionRef.current) {
          // 设置页的分类详情先退回设置列表，再退才是关闭设置页。
          setSettingsSection(null);
        } else if (top.layer === 'viewer' && viewerInfoOpenRef.current) {
          setViewerInfoOpen(false);
        } else if (top.layer === 'organize' && organizeStepRef.current === 2) {
          setOrganizeFlow((prev) => (prev ? { ...prev, step: 1 } : prev));
        } else {
          closeOverlay(top.layer);
        }
        return;
      }
      // 多选不是 history 层：先退出多选，避免硬件返回把当前图包直接退回根目录。
      if (selectModeRef.current) {
        event.preventDefault();
        setSelectMode(false);
        setSelectedIds(new Set());
        return;
      }
      if (stackRef.current.length === 0) return;
      event.preventDefault();
      window.history.back();
    };
    window.addEventListener('kanitsu:android-back', onAndroidBack);
    return () => window.removeEventListener('kanitsu:android-back', onAndroidBack);
  }, [closeOverlay]);

  const navigateToFolder = useCallback(
    (folderId: string) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const target = folderId || snap.rootId;
      // 使用同步 ref 而不是 render 闭包，防止一次触摸被 WebView 合成为两次 click
      // 时连续 push 两个相同目录历史项。
      if (target === (selectedFolderIdRef.current || snap.rootId)) return;
      // 搜索层不随目录导航滞留：同步裁掉 search 栈项并复位搜索 UI。否则它成为
      // 幽灵条目，吞掉下一次硬件返回（返回键"死按"）。
      closeOverlay('search');
      // 选择集与目录绑定：换目录先退出多选，防止跨目录残留的选中数与批量删除
      // 的目标集不一致。
      setSelectMode(false);
      setSelectedIds(new Set());
      const next: StackEntry[] = [...stackRef.current, { type: 'folder', folderId: target }];
      stackRef.current = next;
      window.history.pushState({ kanitsuStack: next }, '');
      selectedFolderIdRef.current = target;
      setSelectedFolderId(target);
      animatePage('forward');
      const folder = snap.folders[target];
      if (folder && folder.childCount > 0) {
        setExpandedFolders((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
      }
    },
    [animatePage, closeOverlay],
  );

  const goUp = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap) return;
    const folder = snap.folders[selectedFolderIdRef.current || snap.rootId];
    const target = folder?.parentId ?? snap.rootId;
    const stack = stackRef.current;
    const top = stack[stack.length - 1];
    setSelectMode(false);
    setSelectedIds(new Set());
    if (top && top.type === 'folder') {
      const previous = [...stack.slice(0, -1)].reverse().find((entry): entry is { type: 'folder'; folderId: string } => entry.type === 'folder');
      const previousId = previous?.folderId ?? snap.rootId;
      if (previousId === target) {
        stackRef.current = stack.slice(0, -1);
        window.history.back();
      } else {
        const next = [...stack.slice(0, -1), { type: 'folder' as const, folderId: target }];
        stackRef.current = next;
        window.history.replaceState({ kanitsuStack: next }, '');
      }
    }
    selectedFolderIdRef.current = target;
    setSelectedFolderId(target);
    animatePage('back');
  }, [animatePage]);

  const openSettings = useCallback(
    (section: SettingsSectionId | null = null) => {
      setSettingsSection(section);
      setShowSettings(true);
      openOverlay('settings');
    },
    [openOverlay],
  );

  const openTasks = useCallback(() => {
    setShowTasks(true);
    setTasksUnseen(false);
    openOverlay('tasks');
  }, [openOverlay]);

  // ===== 滚动：顶栏实底、FAB 收缩、快速滚动暂停预取、位置记忆 =====
  const scrollPositionsRef = useRef(new Map<string, number>());
  const scrollSaveFrameRef = useRef<number | null>(null);
  const scrollPreloadResumeTimerRef = useRef<number | null>(null);
  const scrollMotionRef = useRef(false);
  const appbarSolidRef = useRef(false);
  const fabCompactRef = useRef(false);

  const syncScrollChrome = useCallback(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    const threshold = pageKind === 'folder' ? APPBAR_SOLID_AT_FOLDER : APPBAR_SOLID_AT_ROOT;
    const solid = pageKind === 'search' || el.scrollTop > threshold;
    if (solid !== appbarSolidRef.current) {
      appbarSolidRef.current = solid;
      setAppbarSolid(solid);
    }
    const compact = el.scrollTop > 40;
    if (compact !== fabCompactRef.current) {
      fabCompactRef.current = compact;
      setFabCompact(compact);
    }
  }, [pageKind]);

  const onMainScroll = useCallback(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    syncScrollChrome();
    // 快速滚动时只保留可见/方向预取，暂停当前目录和全库预热，避免后台
    // 请求占满桥接与原生解码时隙。滚动停止一小段时间后再恢复。
    setThumbnailPreloadPaused(true);
    if (!scrollMotionRef.current) {
      scrollMotionRef.current = true;
      el.classList.add('is-fast-scrolling');
    }
    if (scrollPreloadResumeTimerRef.current != null) {
      window.clearTimeout(scrollPreloadResumeTimerRef.current);
    }
    scrollPreloadResumeTimerRef.current = window.setTimeout(() => {
      scrollPreloadResumeTimerRef.current = null;
      setThumbnailPreloadPaused(false);
      scrollMotionRef.current = false;
      mainScrollRef.current?.classList.remove('is-fast-scrolling');
    }, MOBILE_SCROLL_PRELOAD_RESUME_MS);
    if (scrollSaveFrameRef.current != null) return;
    scrollSaveFrameRef.current = requestAnimationFrame(() => {
      scrollSaveFrameRef.current = null;
      const node = mainScrollRef.current;
      if (!node || searchActive) return;
      scrollPositionsRef.current.set(currentFolderId, node.scrollTop);
    });
  }, [currentFolderId, searchActive, syncScrollChrome]);

  useEffect(() => {
    return () => {
      if (scrollPreloadResumeTimerRef.current != null) {
        window.clearTimeout(scrollPreloadResumeTimerRef.current);
        scrollPreloadResumeTimerRef.current = null;
      }
      scrollMotionRef.current = false;
      setThumbnailPreloadPaused(false);
    };
  }, []);

  // 切换目录/搜索开合后恢复滚动位置，并按新页面同步顶栏状态。
  useLayoutEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    el.scrollTop = searchActive ? 0 : scrollPositionsRef.current.get(currentFolderId) ?? 0;
    syncScrollChrome();
  }, [currentFolderId, snapshot == null, searchActive, syncScrollChrome]);

  // ===== 缩略图预取（与桌面同优先级策略）=====
  useEffect(() => {
    if (!snapshot || displayImages.length === 0 || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const files = displayImages.map(imageToFileRef);
    preloadThumbnails(store, files, { priority: THUMB_PRIORITY_CURRENT_DIR, concurrency: 4, shouldStop: () => token.cancelled });
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, currentFolderId, displayImages, store]);

  const coverFolders = isRoot ? libraryPacks : childFolders;
  useEffect(() => {
    if (!snapshot || coverFolders.length === 0 || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const covers: FileRef[] = [];
    const pinnedCoverFiles: FileRef[] = [];
    for (const folder of coverFolders.slice(0, 16)) {
      const cover = coverFor(folder.id);
      if (cover) {
        covers.push(imageToFileRef(cover));
        if (pinnedCovers[folder.id] === cover.id) pinnedCoverFiles.push(imageToFileRef(cover));
      }
      for (const img of imagesOf(snapshot, folder.id).slice(0, 8)) covers.push(imageToFileRef(img));
    }
    if (covers.length > 0) preloadThumbnails(store, covers, { priority: THUMB_PRIORITY_SUBFOLDER, shouldStop: () => token.cancelled });
    if (pinnedCoverFiles.length > 0) {
      preloadThumbnails(store, pinnedCoverFiles, {
        maxSize: COVER_THUMBNAIL_SIZE,
        priority: THUMB_PRIORITY_SUBFOLDER,
        shouldStop: () => token.cancelled,
      });
    }
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, coverFolders, coverFor, pinnedCovers, store]);

  useEffect(() => {
    if (!snapshot || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const all = Object.values(snapshot.images).map(imageToFileRef);
    if (all.length > 0) {
      const run = () => preloadThumbnails(store, all, { priority: THUMB_PRIORITY_WARMUP, shouldStop: () => token.cancelled });
      const idle = window.setTimeout(run, 800);
      return () => {
        token.cancelled = true;
        window.clearTimeout(idle);
      };
    }
    return;
  }, [snapshot, store]);

  // ===== 继续浏览：查看器翻到哪张就记到哪张（防抖写入本机）=====
  useEffect(() => {
    if (!viewerOpen || !viewerImageId || !snapshot) return;
    const folderId = browseFolderFor(snapshot, searching ? snapshot.rootId : currentFolderId, viewerImageId);
    if (!folderId) return;
    const t = window.setTimeout(() => {
      setRecentBrowse((prev) => {
        const next = recordRecentBrowse(prev, folderId, viewerImageId);
        saveRecentBrowse(next);
        return next;
      });
    }, 400);
    return () => window.clearTimeout(t);
  }, [viewerOpen, viewerImageId, snapshot, currentFolderId, searching]);

  // ===== 打开各 UI 层（history 栈配对）=====
  const openViewer = useCallback(
    (image: ImageEntry) => {
      setViewerImageId(image.id);
      setViewerInfoOpen(false);
      // Force a new viewer tree for every open so WebView cannot reuse the
      // previous session's decoded image or compositor layer.
      setViewerSessionId((id) => id + 1);
      openOverlay('viewer');
    },
    [openOverlay],
  );

  const resumeBrowse = useCallback(
    (folderId: string, imageId: string) => {
      const snap = snapshotRef.current;
      const image = snap?.images[imageId];
      if (!snap || !image) return;
      navigateToFolder(folderId);
      // 上次停留的图在子目录里：打开聚合视图，查看器才能在同一序列里定位到它。
      if (image.folderId !== folderId) setAggregate(true);
      openViewer(image);
    },
    [navigateToFolder, openViewer],
  );

  const openPrompt = useCallback(
    (prompt: PromptState) => {
      // 互斥的对话框内容：打开输入框前清掉删除确认的残影（退场 ref）。
      setDeleteTarget(null);
      deleteTargetRef.current = null;
      setPromptState(prompt);
      openOverlay('dialog');
    },
    [openOverlay],
  );

  const openDelete = useCallback(
    (target: DeleteTarget) => {
      // 互斥的对话框内容：打开删除确认前清掉输入框的残影（退场 ref）。
      setPromptState(null);
      promptStateRef.current = null;
      setDeleteTarget(target);
      openOverlay('dialog');
    },
    [openOverlay],
  );

  const openCoverPicker = useCallback(
    (folder: FolderNode) => {
      setCoverPickerFolder(folder);
      openOverlay('cover');
    },
    [openOverlay],
  );

  const openSearch = useCallback(() => {
    setSearchActive(true);
    setSelectMode(false);
    setSelectedIds(new Set());
    animatePage('forward');
    openOverlay('search');
  }, [animatePage, openOverlay]);

  const closeSearch = useCallback(() => {
    closeOverlay('search');
  }, [closeOverlay]);

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    openOverlay('drawer');
  }, [openOverlay]);

  const openDisplaySheet = useCallback(
    (kind: DisplaySheetKind) => {
      setDisplaySheet(kind);
      openOverlay('display');
    },
    [openOverlay],
  );

  const openOrganizeFor = useCallback(
    (folder: FolderNode) => {
      setOrganizeFlow({ folder, step: 1 });
      openOverlay('organize');
    },
    [openOverlay],
  );

  // ===== 业务操作 =====
  const handleImport = useCallback(async () => {
    if (importingRef.current) return;
    importingRef.current = true;
    const token = `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const taskId = startTask({ kind: 'import', title: '导入图包', detail: '正在读取文件夹…', cancelable: true });
    taskCancelRef.current.set(taskId, () => void store.cancelTask?.(token));
    try {
      const task = await importFolder(picker, store, {
        cancelToken: token,
        onProgress: (p) =>
          patchTask(taskId, {
            done: p.copied,
            detail: `已扫描 ${p.scanned} · 已复制 ${p.copied} · 跳过 ${p.skipped}`,
          }),
      });
      const title = `导入「${task.targetTopFolder || task.sourceFolderName}」`;
      const next = await refresh();
      const topFolder = Object.values(next.folders).find((f) => f.parentId === next.rootId && f.name === task.targetTopFolder);
      if (topFolder) {
        setImportedAt((prev) => {
          const map = { ...prev, [topFolder.id]: Date.now() };
          saveImportedAt(map);
          return map;
        });
      }
      const skipped = task.skippedCount > 0 ? ` · 跳过 ${task.skippedCount} 个` : '';
      if (task.status === 'canceled') {
        finishTask(taskId, 'canceled', { title, report: task, result: `已取消 · 已复制 ${task.copiedImageCount} 张`, openFolderId: topFolder?.id });
        notify(`导入已取消：已复制 ${task.copiedImageCount} 张`, 'info');
        return;
      }
      finishTask(taskId, 'done', {
        title,
        report: task,
        result: `复制 ${task.copiedImageCount} 张${skipped}${task.errors.length ? ` · 失败 ${task.errors.length} 个` : ''}`,
        openFolderId: topFolder?.id,
      });
      notify(
        `已导入「${task.targetTopFolder}」· ${task.copiedImageCount} 张${skipped}`,
        'success',
        topFolder ? { label: '打开', onPress: () => navigateToFolder(topFolder.id) } : undefined,
      );
    } catch (err) {
      const msg = String(err);
      if (/取消/.test(msg)) {
        // 选择文件夹时取消：不留下空任务。
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
        taskCancelRef.current.delete(taskId);
      } else {
        finishTask(taskId, 'failed', { result: `失败：${msg}` });
        notify(`导入失败：${msg}`, 'error');
      }
    } finally {
      importingRef.current = false;
    }
  }, [picker, store, refresh, navigateToFolder, notify, startTask, patchTask, finishTask]);

  const handleUndoOrganize = useCallback(
    async (taskId?: string) => {
      const last = lastManifest;
      if (!last || organizingRef.current || (taskId && taskId !== last.taskId)) return;
      organizingRef.current = true;
      try {
        const result = await undoOrganize(store, last.manifest);
        setLastManifest(null);
        setTasks((prev) =>
          prev.map((t) => (t.id === last.taskId ? { ...t, undoable: false, result: `${t.result ?? ''} · 已撤销` } : t)),
        );
        await refresh();
        notify(
          result.errors.length > 0
            ? `撤销完成：已还原 ${result.undone} 项，${result.errors.length} 项失败`
            : `已撤销整理，还原 ${result.undone} 项`,
        );
      } catch (err) {
        notify(`撤销失败：${String(err)}`, 'error');
      } finally {
        organizingRef.current = false;
      }
    },
    [lastManifest, store, refresh, notify],
  );
  const undoRef = useRef(handleUndoOrganize);
  undoRef.current = handleUndoOrganize;

  const handleApplyOrganize = useCallback(
    async (bindings: OrganizeBinding[], ruleName: string) => {
      const flow = organizeFlow;
      const snap = snapshotRef.current;
      if (!flow || !snap || organizingRef.current) return;
      closeOverlay('organize');
      organizingRef.current = true;
      const flag = { cancelled: false };
      const taskId = startTask({ kind: 'organize', title: `整理「${flow.folder.name}」`, total: bindings.length, cancelable: true });
      taskCancelRef.current.set(taskId, () => {
        flag.cancelled = true;
      });
      try {
        const result = await applyOrganize(store, snap, flow.folder.relPath, bindings, {
          onProgress: (done, total) => patchTask(taskId, { done, total }),
          shouldCancel: () => flag.cancelled,
        });
        const dirs = new Set(bindings.map((b) => b.virtualPath.split('/').slice(0, -1).join('/'))).size;
        const summary = `按「${ruleName}」移动 ${result.appliedCount} 张 · ${dirs} 个目录${result.conflicts.length ? ` · ${result.conflicts.length} 个冲突` : ''}`;
        const undoable = result.appliedCount > 0;
        setTasks((prev) => prev.map((t) => (t.undoable ? { ...t, undoable: false } : t)));
        finishTask(taskId, result.canceled ? 'canceled' : 'done', {
          result: result.canceled ? `已取消 · ${summary}` : summary,
          conflicts: result.conflicts,
          undoable,
          openFolderId: flow.folder.id,
        });
        setLastManifest(undoable ? { taskId, manifest: result.manifest } : null);
        await refresh();
        notify(
          result.canceled
            ? `整理已取消：已移动 ${result.appliedCount} 张`
            : `已整理 ${result.appliedCount} 张${result.conflicts.length ? `，${result.conflicts.length} 个冲突` : ''}`,
          'success',
          undoable ? { label: '撤销', onPress: () => void undoRef.current(taskId) } : undefined,
        );
      } catch (err) {
        finishTask(taskId, 'failed', { result: `失败：${String(err)}` });
        notify(`整理失败：${String(err)}`, 'error');
      } finally {
        organizingRef.current = false;
      }
    },
    [organizeFlow, store, refresh, notify, closeOverlay, startTask, patchTask, finishTask],
  );

  /** 导出 ZIP：整个目录（zipLibrary）或所选图片（zipSelection）。 */
  const runExport = useCallback(
    async (title: string, run: (onProgress: (done: number, total: number) => void, token: string) => Promise<{ canceled?: boolean; exportedCount: number; totalImages: number }>) => {
      if (exportingRef.current) return;
      exportingRef.current = true;
      const token = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const taskId = startTask({ kind: 'export', title, detail: '选择保存位置…', cancelable: true });
      taskCancelRef.current.set(taskId, () => void store.cancelTask?.(token));
      try {
        const result = await run((done, total) => patchTask(taskId, { done, total, detail: undefined }), token);
        if (result.canceled) {
          finishTask(taskId, 'canceled', { result: `已取消 · 已写入 ${result.exportedCount} 张` });
          notify(`导出已取消：已写入 ${result.exportedCount} 张`, 'info');
        } else {
          finishTask(taskId, 'done', { done: result.exportedCount, total: result.totalImages, result: `已导出 ${result.exportedCount} 张` });
          notify(`已导出 ${result.exportedCount} 张图片`, 'success');
        }
      } catch (err) {
        const msg = String(err);
        if (/取消/.test(msg)) {
          setTasks((prev) => prev.filter((t) => t.id !== taskId));
          taskCancelRef.current.delete(taskId);
        } else {
          finishTask(taskId, 'failed', { result: `失败：${msg}` });
          notify(`导出失败：${msg}`, 'error');
        }
      } finally {
        exportingRef.current = false;
      }
    },
    [store, notify, startTask, patchTask, finishTask],
  );

  const handleExport = useCallback(
    (folder: FolderNode) =>
      void runExport(`导出「${folder.name || '全部图包'}」`, (onProgress, token) => store.zipLibrary(folder.relPath, onProgress, token)),
    [runExport, store],
  );

  const cancelTask = useCallback((task: MobileTask) => {
    taskCancelRef.current.get(task.id)?.();
  }, []);

  // —— 多选 / 批量操作 ——
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);
  const handleEnterSelectMode = useCallback(() => {
    setSelectedIds(new Set());
    setSelectMode(true);
  }, []);
  const handleSelectAll = useCallback(() => {
    setSelectedIds((prev) => (prev.size === displayImages.length ? new Set() : new Set(displayImages.map((img) => img.id))));
  }, [displayImages]);
  const selectedImages = useMemo(() => displayImages.filter((img) => selectedIds.has(img.id)), [displayImages, selectedIds]);

  // —— 长按拖动连选：以长按起点为锚，手指经过的区间与起始选择集合并 ——
  const displayImagesRef = useRef(displayImages);
  displayImagesRef.current = displayImages;
  const dragSelectRef = useRef<{ anchor: number; last: number; base: ReadonlySet<string>; x: number; y: number; frame: number } | null>(null);

  const startDragSelect = useCallback(
    (image: ImageEntry, index: number) => {
      const base = selectModeRef.current ? new Set(selectedIds) : new Set<string>();
      base.add(image.id);
      setSelectMode(true);
      setSelectedIds(base);
      dragSelectRef.current = { anchor: index, last: index, base, x: 0, y: 0, frame: 0 };
    },
    [selectedIds],
  );

  // —— 图片网格手势：双指捏合改列数、长按后拖动连选（非被动监听，按需阻止滚动）——
  const gridColsRef = useRef(gridCols);
  gridColsRef.current = gridCols;
  const pinchAnchorRef = useRef<{ index: number; clientY: number } | null>(null);
  const pinchEnabled = pageKind === 'folder' && viewMode === 'grid' && displayImages.length > 0;
  const pinchEnabledRef = useRef(pinchEnabled);
  pinchEnabledRef.current = pinchEnabled;

  const changeGridCols = useCallback((cols: number, anchor?: { index: number; clientY: number }) => {
    const next = Math.max(IMAGE_GRID.minCols, Math.min(IMAGE_GRID.maxCols, cols));
    if (next === gridColsRef.current) return;
    pinchAnchorRef.current = anchor ?? null;
    gridColsRef.current = next;
    setGridCols(next);
    saveImageGridCols(next);
    haptic(8);
  }, []);

  // 列数变化后把捏合中心下的那张图放回原来的屏幕位置，避免内容跳走。
  useLayoutEffect(() => {
    const anchor = pinchAnchorRef.current;
    const el = mainScrollRef.current;
    pinchAnchorRef.current = null;
    if (!anchor || !el) return;
    const node = el.querySelector<HTMLElement>(`[data-grid-index="${anchor.index}"]`);
    if (!node) return;
    el.scrollTop += node.getBoundingClientRect().top - anchor.clientY;
  }, [gridCols]);

  useEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    let pinch: { dist: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
    const hitIndex = (x: number, y: number): number | null => {
      const node = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-grid-index]');
      if (!node || !el.contains(node)) return null;
      const n = Number(node.dataset.gridIndex);
      return Number.isFinite(n) ? n : null;
    };
    const applyRange = () => {
      const drag = dragSelectRef.current;
      if (!drag) return;
      const idx = hitIndex(drag.x, drag.y);
      if (idx == null || idx === drag.last) return;
      drag.last = idx;
      const images = displayImagesRef.current;
      const next = new Set(drag.base);
      for (let i = Math.min(drag.anchor, idx); i <= Math.max(drag.anchor, idx); i++) {
        const img = images[i];
        if (img) next.add(img.id);
      }
      setSelectedIds(next);
    };
    const autoScroll = () => {
      const drag = dragSelectRef.current;
      if (!drag) return;
      const rect = el.getBoundingClientRect();
      let speed = 0;
      if (drag.y < rect.top + DRAG_EDGE) speed = -DRAG_MAX_SPEED * (1 - Math.max(0, drag.y - rect.top) / DRAG_EDGE);
      else if (drag.y > rect.bottom - DRAG_EDGE) speed = DRAG_MAX_SPEED * (1 - Math.max(0, rect.bottom - drag.y) / DRAG_EDGE);
      if (speed !== 0) {
        el.scrollTop += speed;
        applyRange();
      }
      drag.frame = requestAnimationFrame(autoScroll);
    };
    const endDrag = () => {
      const drag = dragSelectRef.current;
      if (drag) cancelAnimationFrame(drag.frame);
      dragSelectRef.current = null;
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchEnabledRef.current) {
        endDrag();
        pinch = { dist: dist(e.touches) };
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const d = dist(e.touches);
        const ratio = d / pinch.dist;
        if (ratio > PINCH_STEP_RATIO || ratio < 1 / PINCH_STEP_RATIO) {
          const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2;
          const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2;
          const index = hitIndex(midX, midY);
          const node = index != null ? el.querySelector<HTMLElement>(`[data-grid-index="${index}"]`) : null;
          changeGridCols(
            gridColsRef.current + (ratio > 1 ? -1 : 1),
            index != null && node ? { index, clientY: node.getBoundingClientRect().top } : undefined,
          );
          pinch.dist = d;
        }
        return;
      }
      const drag = dragSelectRef.current;
      if (drag && e.touches.length === 1) {
        e.preventDefault();
        drag.x = e.touches[0]!.clientX;
        drag.y = e.touches[0]!.clientY;
        if (!drag.frame) drag.frame = requestAnimationFrame(autoScroll);
        applyRange();
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 0) endDrag();
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      endDrag();
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [changeGridCols]);

  // 桌面预览（?mobile-preview=1）没有多点触控：Ctrl + 滚轮模拟捏合。
  useEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !pinchEnabledRef.current) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) > 60) {
        changeGridCols(gridColsRef.current + Math.sign(acc));
        acc = 0;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [changeGridCols]);

  /** 批量删除入口：走应用内确认对话框（不用原生 window.confirm）。 */
  const handleBatchDelete = useCallback(() => {
    if (selectedImages.length === 0) return;
    setPromptState(null);
    promptStateRef.current = null;
    setDeleteTarget({ kind: 'batch', count: selectedImages.length });
    openOverlay('dialog');
  }, [selectedImages, openOverlay]);

  /** 批量删除执行体：逐项失败计数 + 任务进度，refresh 失败也不让状态悬空。 */
  const runBatchDelete = useCallback(async () => {
    const targets = selectedImages;
    if (targets.length === 0) return;
    let ok = 0;
    let failed = 0;
    const taskId = startTask({ kind: 'delete', title: `删除 ${targets.length} 张图片`, total: targets.length });
    exitSelectMode();
    for (let i = 0; i < targets.length; i++) {
      try {
        await deleteImage(store, targets[i]!);
        ok++;
      } catch {
        failed++;
      }
      patchTask(taskId, { done: i + 1 });
    }
    finishTask(taskId, 'done', { result: failed > 0 ? `已删除 ${ok} 张，失败 ${failed} 张` : `已删除 ${ok} 张` });
    try {
      await refresh();
    } catch (err) {
      notify(`刷新失败：${String(err)}`, 'error');
    }
    notify(failed > 0 ? `已删除 ${ok} 张，失败 ${failed} 张` : `已从图库删除 ${ok} 张（源文件夹不受影响）`, failed > 0 ? 'error' : 'success');
  }, [selectedImages, store, refresh, exitSelectMode, notify, startTask, patchTask, finishTask]);

  const handleDeleteConfirm = useCallback(async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    closeOverlay('dialog');
    if (!target) return;
    try {
      if (target.kind === 'image') {
        await deleteImage(store, target.image);
        await refresh();
        notify(`已删除「${target.image.name}」`, 'success');
      } else if (target.kind === 'folder') {
        await deleteLibraryFolder(store, target.folder.relPath);
        // 删的是当前所在图包：先按旧快照退回上级，再重扫（重扫后该目录已不存在）。
        if (currentFolderId === target.folder.id) goUp();
        await refresh();
        notify(`已删除「${target.folder.name}」`, 'success');
      } else {
        await runBatchDelete();
      }
    } catch (err) {
      notify(`删除失败：${String(err)}`, 'error');
    }
  }, [deleteTarget, store, refresh, notify, closeOverlay, currentFolderId, runBatchDelete, goUp]);

  const handlePromptSubmit = useCallback(
    async (value: string) => {
      const prompt = promptState;
      setPromptState(null);
      closeOverlay('dialog');
      if (!prompt) return;
      try {
        if (prompt.kind === 'rename-image') {
          if (value === prompt.image.name) return;
          const renamed = await renameImage(store, prompt.image, value);
          await refresh();
          notify(`已重命名为「${renamed.name}」`, 'success');
        } else if (prompt.kind === 'rename-folder') {
          if (value === prompt.folder.name) return;
          await renameFolder(store, prompt.folder, value);
          await refresh();
          notify(`已重命名为「${value}」`, 'success');
        } else if (prompt.kind === 'batch-move') {
          // 批量移动：在当前目录新建子文件夹，把选中的图片移进去。
          const created = await createSubfolder(store, selectedFolder?.relPath ?? '', value);
          const targets = selectedImages;
          let moved = 0;
          let failed = 0;
          const taskId = startTask({ kind: 'move', title: `移动 ${targets.length} 张到「${value}」`, total: targets.length });
          exitSelectMode();
          for (let i = 0; i < targets.length; i++) {
            const img = targets[i]!;
            try {
              await store.move({ id: img.fileRefId ?? img.id, name: img.name, kind: 'file' }, created, img.name);
              moved++;
            } catch {
              failed++;
            }
            patchTask(taskId, { done: i + 1 });
          }
          finishTask(taskId, 'done', { result: failed > 0 ? `已移动 ${moved} 张，失败 ${failed} 张` : `已移动 ${moved} 张` });
          await refresh();
          notify(
            failed > 0 ? `已移动 ${moved} 张到「${value}」，失败 ${failed} 张` : `已移动 ${moved} 张到「${value}」`,
            failed > 0 ? 'error' : 'success',
          );
        } else {
          await createSubfolder(store, prompt.folder.relPath, value);
          const next = await refresh();
          const created = Object.values(next.folders).find((f) => f.parentId === prompt.folder.id && f.name === value);
          if (created) navigateToFolder(created.id);
          notify(`已创建「${value}」`, 'success');
        }
      } catch (err) {
        notify(`操作失败：${String(err)}`, 'error');
      }
    },
    [promptState, store, refresh, notify, closeOverlay, navigateToFolder, selectedFolder, selectedImages, exitSelectMode, startTask, patchTask, finishTask],
  );

  const setImagesBlurred = useCallback((images: readonly ImageEntry[], blurred: boolean) => {
    setBlurredImages((prev) => {
      const next = new Set(prev);
      for (const img of images) {
        if (blurred) next.add(img.relPath);
        else next.delete(img.relPath);
      }
      saveBlurredImages(next);
      return next;
    });
  }, []);

  const toggleImageBlur = useCallback(
    (image: ImageEntry) => {
      const blurred = blurredImages.has(image.relPath);
      setImagesBlurred([image], !blurred);
      notify(blurred ? '已取消隐私预览' : '已设为隐私预览：网格与查看器中都会遮挡', 'success');
    },
    [blurredImages, setImagesBlurred, notify],
  );

  const toggleFolderBlur = useCallback(
    (folder: FolderNode) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const images = imagesOf(snap, folder.id);
      if (images.length === 0) return;
      const allBlurred = images.every((img) => blurredImages.has(img.relPath));
      setImagesBlurred(images, !allBlurred);
      notify(allBlurred ? `已取消「${folder.name}」的隐私预览` : `已为「${folder.name}」全部图片开启隐私预览`, 'success');
    },
    [blurredImages, setImagesBlurred, notify],
  );

  const pinCover = useCallback(
    (folderId: string, imageId: string | null, label?: string) => {
      setPinnedCovers((prev) => {
        const next = { ...prev };
        if (imageId) next[folderId] = imageId;
        else delete next[folderId];
        savePinnedCovers(next);
        return next;
      });
      const folderName = snapshotRef.current?.folders[folderId]?.name;
      notify(imageId ? `已将「${label ?? '该图片'}」设为「${folderName ?? '图包'}」的封面` : '已取消固定封面，将自动挑选', 'success');
    },
    [notify],
  );

  /** 查看器/多选里「设为封面」的目标图包：当前浏览的图包；从根目录（搜索）打开时取图片所在目录。 */
  const coverTargetFor = useCallback(
    (image: ImageEntry) => (isRoot || searching ? image.folderId : currentFolderId),
    [isRoot, searching, currentFolderId],
  );

  const copyText = useCallback(
    async (text: string, label = '路径') => {
      try {
        await navigator.clipboard.writeText(text);
        notify(`已复制${label}`, 'success');
      } catch {
        notify(`无法复制，请手动复制：${text}`, 'error');
      }
    },
    [notify],
  );

  // ===== 动作面板模型 =====
  const openImageActions = useCallback(
    (image: ImageEntry, fromViewer = false) => {
      const blurred = blurredImages.has(image.relPath);
      const coverFolderId = coverTargetFor(image);
      const pinned = pinnedCovers[coverFolderId] === image.id;
      setSheet({
        title: image.name,
        subtitle: [image.width && image.height ? `${image.width}×${image.height}` : '', image.size ? formatBytes(image.size) : '']
          .filter(Boolean)
          .join(' · '),
        media: image,
        quickActions: [
          {
            label: pinned ? '取消封面' : '设为封面',
            icon: 'image',
            onSelect: () => pinCover(coverFolderId, pinned ? null : image.id, image.name),
          },
          { label: blurred ? '取消模糊' : '模糊', icon: blurred ? 'eye' : 'eye-off', onSelect: () => toggleImageBlur(image) },
          { label: '重命名', icon: 'edit', onSelect: () => openPrompt({ kind: 'rename-image', image }) },
          { label: '复制路径', icon: 'link', onSelect: () => void copyText(image.relPath) },
        ],
        actions: [
          ...(!fromViewer ? [{ label: '查看', icon: 'image' as const, onSelect: () => openViewer(image) }] : []),
          { label: '删除', icon: 'trash', danger: true, onSelect: () => openDelete({ kind: 'image', image }) },
        ],
      });
      openOverlay('sheet');
    },
    [blurredImages, pinnedCovers, coverTargetFor, pinCover, toggleImageBlur, openPrompt, copyText, openViewer, openDelete, openOverlay],
  );

  const openFolderActions = useCallback(
    (folder: FolderNode) => {
      const snap = snapshotRef.current;
      const images = snap ? imagesOf(snap, folder.id) : [];
      const allBlurred = images.length > 0 && images.every((img) => blurredImages.has(img.relPath));
      const isRootFolder = !folder.relPath;
      const isCurrent = folder.id === currentFolderId;
      const pinned = pinnedCovers[folder.id] != null;
      setSheet({
        title: folder.name || '全部图包',
        subtitle: `${folder.imageCount} 张 · ${formatBytes(folderStats.get(folder.id)?.bytes ?? 0)}${folder.relPath ? ` · ${folder.relPath}` : ''}`,
        media: coverFor(folder.id),
        quickActions: [
          { label: '整理', icon: 'wand', disabled: images.length === 0, onSelect: () => openOrganizeFor(folder) },
          { label: '导出 ZIP', icon: 'zip', disabled: images.length === 0, onSelect: () => handleExport(folder) },
          { label: '新建子目录', icon: 'folder-plus', onSelect: () => openPrompt({ kind: 'create-folder', folder }) },
          { label: '设置封面', icon: 'image', disabled: images.length === 0, onSelect: () => openCoverPicker(folder) },
        ],
        actions: [
          ...(!isCurrent ? [{ label: '打开', icon: 'folder' as const, onSelect: () => navigateToFolder(folder.id) }] : []),
          ...(!isRootFolder ? [{ label: '重命名', icon: 'edit' as const, onSelect: () => openPrompt({ kind: 'rename-folder', folder }) }] : []),
          ...(pinned ? [{ label: '取消固定封面', icon: 'pin' as const, onSelect: () => pinCover(folder.id, null) }] : []),
          {
            label: allBlurred ? '取消隐私预览（含子目录）' : '隐私预览（含子目录）',
            icon: allBlurred ? 'eye' : 'eye-off',
            disabled: images.length === 0,
            onSelect: () => toggleFolderBlur(folder),
          },
          { label: '复制路径', icon: 'link', onSelect: () => void copyText(folder.relPath || '（根目录）') },
          ...(isCurrent ? [{ label: '重新扫描', icon: 'refresh' as const, onSelect: () => void handleRefresh() }] : []),
          ...(!isRootFolder ? [{ label: '删除图包', icon: 'trash' as const, danger: true, onSelect: () => openDelete({ kind: 'folder', folder }) }] : []),
        ],
      });
      openOverlay('sheet');
    },
    [
      blurredImages,
      currentFolderId,
      pinnedCovers,
      folderStats,
      coverFor,
      openOrganizeFor,
      handleExport,
      openPrompt,
      openCoverPicker,
      navigateToFolder,
      pinCover,
      toggleFolderBlur,
      copyText,
      handleRefresh,
      openDelete,
      openOverlay,
    ],
  );

  const handleCustomRulesChange = useCallback((rules: CustomOrganizeRule[]) => {
    setCustomRules(rules);
    saveCustomRules(rules);
  }, []);

  const toggleFolderExpand = useCallback((folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  const updateLibPrefs = useCallback((next: LibraryPrefs) => {
    setLibPrefs(next);
    saveLibraryPrefs(next);
  }, []);

  const rememberSearch = useCallback(() => {
    if (searchQuery) setRecentSearches((prev) => pushRecentSearch(prev, searchQuery));
  }, [searchQuery]);

  // ===== 渲染片段 =====
  const imageItem = (img: ImageEntry, i: number, list: 'grid' | 'list', inSelect: boolean) => {
    const props = {
      image: img,
      index: i,
      store,
      blurred: blurredImages.has(img.relPath),
      selectMode: inSelect,
      selected: inSelect && selectedIds.has(img.id),
      onOpen: () => {
        if (searching) rememberSearch();
        openViewer(img);
      },
      onToggleSelect: toggleSelect,
      onLongPress: inSelect || pageKind === 'folder' ? startDragSelect : (image: ImageEntry) => openImageActions(image),
    };
    return list === 'grid' ? <ImageCard {...props} showName={showFileNames} /> : <ImageListRow {...props} />;
  };

  const packCard = (folder: FolderNode, row = false) => {
    const cover = coverFor(folder.id);
    const common = {
      folder,
      cover,
      store,
      pinned: pinnedCovers[folder.id] != null,
      blurred: cover ? isImageBlurred(cover.relPath, blurredImages) : false,
      onOpen: () => {
        if (searching) rememberSearch();
        navigateToFolder(folder.id);
      },
      onActions: () => openFolderActions(folder),
    };
    return row ? (
      <PackRow {...common} subtitle={`${folder.imageCount} 张 · ${packSubtitle(folder)}`} />
    ) : (
      <PackCard {...common} subtitle={packSubtitle(folder)} />
    );
  };

  const emptyLibrary = (
    <section className="m2-onboarding">
      <div className="m2-onboarding-art" aria-hidden="true">
        <span />
        <span />
        <span>
          <MobileIcon name="images" className="w-10 h-10" />
        </span>
      </div>
      <h1>
        把散落的图包，
        <br />
        收进一个图库。
      </h1>
      <p>选择一个文件夹，Kanitsu 会把图片复制到自己的图库；之后的浏览、整理、删除都只作用于这份副本。</p>
      <ul>
        <li>
          <MobileIcon name="shield" className="w-[18px] h-[18px]" />
          源文件夹不会被修改
        </li>
        <li>
          <MobileIcon name="cloud-off" className="w-[18px] h-[18px]" />
          不联网、不上传，也不申请全盘存储权限
        </li>
        <li>
          <MobileIcon name="aperture" className="w-[18px] h-[18px]" />
          JPG / PNG / WebP / AVIF / GIF{enableRaw ? '，以及 RAW' : ''}
          {enableHeif ? ' 与 HEIC' : ''}
        </li>
      </ul>
      <button className="m2-button is-primary" disabled={importing} onClick={() => void handleImport()}>
        <MobileIcon name="folder" className="w-[18px] h-[18px]" />
        {importing ? '正在导入…' : '选择文件夹导入'}
      </button>
    </section>
  );

  const renderLibrary = () => {
    if (!snapshot || !rootFolder) return null;
    if (rootFolder.childCount === 0) return emptyLibrary;
    const continueItems = libFilter === 'all' ? continueResolved.items : [];
    return (
      <>
        <section className="m2-lib-head">
          <h1>图库</h1>
          <div className="m2-meta tabular-nums">
            {rootFolder.childCount} 个图包 · {libraryStats.imageCount.toLocaleString('zh-CN')} 张 · {formatBytes(libraryStats.bytes)}
          </div>
        </section>
        <button className="m2-search-pill" onClick={openSearch}>
          <MobileIcon name="search" className="w-[18px] h-[18px]" />
          <span>搜索图包或文件名</span>
        </button>
        <div className="m2-chips" role="toolbar" aria-label="图包筛选">
          {(
            [
              ['all', '全部', null],
              ['recent', '最近导入', 'clock'],
              ['pinned', '已固定', 'pin'],
            ] as const
          ).map(([value, label, icon]) => (
            <button key={value} className={`m2-chip ${libFilter === value ? 'is-on' : ''}`} aria-pressed={libFilter === value} onClick={() => setLibFilter(value)}>
              {icon && <MobileIcon name={icon} className="w-4 h-4" />}
              {label}
            </button>
          ))}
          <span className="flex-1" />
          <button className="m2-chip is-ghost" onClick={() => openDisplaySheet('library')} aria-label="图包排列">
            <MobileIcon name="sort" className="w-4 h-4" />
            {{ recent: '最近导入', name: '名称', count: '图片数', size: '占用' }[libPrefs.sort]}
          </button>
        </div>
        {continueItems.length > 0 && (
          <>
            <div className="m2-section-head">
              <h2>继续浏览</h2>
              <span className="m2-section-note">仅记录在本机</span>
            </div>
            <div className="m2-continue-strip">
              {continueItems.map((item) => {
                const folder = snapshot.folders[item.folderId]!;
                const image = snapshot.images[item.imageId]!;
                return (
                  <ContinueCard
                    key={item.folderId}
                    folder={folder}
                    image={image}
                    position={item.position}
                    total={item.total}
                    store={store}
                    blurred={blurredImages.has(image.relPath)}
                    onOpen={() => resumeBrowse(item.folderId, item.imageId)}
                  />
                );
              })}
            </div>
          </>
        )}
        <div className="m2-section-head">
          <h2>
            图包<span className="tabular-nums">{libraryPacks.length}</span>
          </h2>
          <button
            className="m2-icon-button is-small"
            onClick={() => updateLibPrefs({ ...libPrefs, view: libPrefs.view === 'grid' ? 'list' : 'grid' })}
            aria-label={libPrefs.view === 'grid' ? '切换为列表' : '切换为封面网格'}
          >
            <MobileIcon name={libPrefs.view === 'grid' ? 'list' : 'grid'} className="w-[18px] h-[18px]" />
          </button>
        </div>
        {libraryPacks.length === 0 ? (
          <p className="m2-empty-line">{libFilter === 'pinned' ? '还没有固定封面的图包。' : '最近 7 天没有导入新的图包。'}</p>
        ) : libPrefs.view === 'grid' ? (
          <RowGrid
            className="m2-pack-grid"
            items={libraryPacks}
            cols={libraryPacks.length === 1 ? 1 : libPrefs.cols}
            gap={FOLDER_GRID.gap}
            getKey={(f) => f.id}
            renderItem={(f) => packCard(f)}
          />
        ) : (
          <div className="m2-pack-list">{libraryPacks.map((f) => <div key={f.id}>{packCard(f, true)}</div>)}</div>
        )}
      </>
    );
  };

  const renderFolder = () => {
    if (!snapshot || !selectedFolder) return null;
    const cover = coverFor(selectedFolder.id);
    const coverBlurred = cover ? isImageBlurred(cover.relPath, blurredImages) : false;
    const crumbs: FolderNode[] = [];
    for (let f = selectedFolder.parentId ? snapshot.folders[selectedFolder.parentId] : undefined; f && f.id !== snapshot.rootId; f = f.parentId ? snapshot.folders[f.parentId] : undefined) {
      crumbs.unshift(f);
    }
    const imported = importedAt[selectedFolder.id];
    const hasAnyImages = selectedFolder.imageCount > 0;
    return (
      <>
        <section className="m2-hero">
          <div className="m2-hero-bg" aria-hidden="true">
            {cover && <BlobImage store={store} fileRef={imageToFileRef(cover)} alt="" className="w-full h-full object-cover" thumbnail blur />}
          </div>
          <div className="m2-hero-fg">
            <div className="m2-hero-poster">
              {cover ? (
                <BlobImage
                  store={store}
                  fileRef={imageToFileRef(cover)}
                  alt=""
                  className="w-full h-full object-cover"
                  thumbnail
                  thumbnailSize={COVER_THUMBNAIL_SIZE}
                  blur={coverBlurred}
                />
              ) : (
                <div className="m2-placeholder">
                  <MobileIcon name="folder" className="w-8 h-8" />
                </div>
              )}
            </div>
            <div className="m2-hero-copy">
              <button className="m2-crumb" onClick={openDrawer} aria-label="打开目录树">
                <MobileIcon name="folder" className="w-3.5 h-3.5 shrink-0" />
                <span>{['图库', ...crumbs.map((c) => c.name)].join(' › ')}</span>
                <MobileIcon name="chevron-down" className="w-3.5 h-3.5 shrink-0" />
              </button>
              <h1>{selectedFolder.name}</h1>
              <div className="m2-meta tabular-nums">
                {selectedFolder.imageCount} 张
                {selectedFolder.childCount > 0 ? ` · ${selectedFolder.childCount} 个子目录` : ''} · {formatBytes(folderStats.get(selectedFolder.id)?.bytes ?? 0)}
                {imported ? ` · ${formatRelativeTime(imported)}导入` : ''}
              </div>
            </div>
          </div>
        </section>
        <div className="m2-actions" role="toolbar" aria-label="图包操作">
          <button className="m2-action is-primary" disabled={!hasAnyImages || organizing} onClick={() => openOrganizeFor(selectedFolder)}>
            <MobileIcon name="wand" className="w-[18px] h-[18px]" />
            智能整理
          </button>
          <button className="m2-action" disabled={displayImages.length === 0} onClick={handleEnterSelectMode}>
            <MobileIcon name="select-all" className="w-[18px] h-[18px]" />
            选择
          </button>
          <button className="m2-action" disabled={!hasAnyImages || exporting} onClick={() => handleExport(selectedFolder)}>
            <MobileIcon name="zip" className="w-[18px] h-[18px]" />
            导出 ZIP
          </button>
          <button className="m2-action" disabled={!hasAnyImages} onClick={() => openCoverPicker(selectedFolder)}>
            <MobileIcon name="image" className="w-[18px] h-[18px]" />
            封面
          </button>
        </div>
        {childFolders.length > 0 && (
          <>
            <div className="m2-section-head">
              <h2>
                子目录<span className="tabular-nums">{childFolders.length}</span>
              </h2>
              <button className="m2-text-button" onClick={() => openPrompt({ kind: 'create-folder', folder: selectedFolder })}>
                新建
              </button>
            </div>
            <div className="m2-subfolder-strip">
              {childFolders.map((f) => {
                const c = coverFor(f.id);
                return (
                  <SubfolderCard
                    key={f.id}
                    folder={f}
                    cover={c}
                    store={store}
                    pinned={pinnedCovers[f.id] != null}
                    blurred={c ? isImageBlurred(c.relPath, blurredImages) : false}
                    onOpen={() => navigateToFolder(f.id)}
                    onActions={() => openFolderActions(f)}
                  />
                );
              })}
            </div>
          </>
        )}
        <div className="m2-images-head">
          <h2>
            图片<span className="tabular-nums">{displayImages.length}</span>
          </h2>
          {selectedFolder.childCount > 0 && (
            <button className={`m2-chip ${aggregate ? 'is-on' : ''}`} aria-pressed={aggregate} onClick={() => setAggregate((v) => !v)}>
              <MobileIcon name="layers" className="w-4 h-4" />
              含子目录
            </button>
          )}
          <button className="m2-icon-button" onClick={() => openDisplaySheet('images')} aria-label="显示选项">
            <MobileIcon name="tune" className="w-[22px] h-[22px]" />
          </button>
        </div>
        {displayImages.length === 0 ? (
          <div className="m2-inline-empty">
            {selectedFolder.childCount > 0 && !aggregate ? (
              <>
                <p>当前目录没有直接存放的图片。</p>
                <button className="m2-chip-button" onClick={() => setAggregate(true)}>
                  显示子目录中的 {selectedFolder.imageCount} 张
                </button>
              </>
            ) : (
              <>
                <p>这个目录还是空的。</p>
                <button className="m2-chip-button" onClick={() => openPrompt({ kind: 'create-folder', folder: selectedFolder })}>
                  新建子目录
                </button>
              </>
            )}
          </div>
        ) : viewMode === 'list' ? (
          <RowGrid className="m2-image-list" items={displayImages} cols={1} gap={2} getKey={(img) => img.id} renderItem={(img, i) => imageItem(img, i, 'list', selectMode)} />
        ) : (
          <RowGrid
            className="m2-image-grid"
            style={{ ['--m2-cell-radius' as string]: `${Math.max(5, 18 - gridCols * 2)}px` }}
            items={displayImages}
            cols={gridCols}
            gap={imageGridGap(gridCols)}
            getKey={(img) => img.id}
            renderItem={(img, i) => imageItem(img, i, 'grid', selectMode)}
          />
        )}
      </>
    );
  };

  const renderSearch = () => {
    if (!snapshot) return null;
    if (!searchTerm) {
      return (
        <>
          {recentSearches.length > 0 && (
            <>
              <div className="m2-section-head">
                <h2>最近搜索</h2>
                <button
                  className="m2-text-button"
                  onClick={() => {
                    clearRecentSearches();
                    setRecentSearches([]);
                  }}
                >
                  清除
                </button>
              </div>
              <div className="m2-chips is-wrap">
                {recentSearches.map((q) => (
                  <button key={q} className="m2-chip" onClick={() => setSearchInput(q)}>
                    <MobileIcon name="clock" className="w-4 h-4" />
                    {q}
                  </button>
                ))}
              </div>
            </>
          )}
          {formatChips.length > 0 && (
            <>
              <div className="m2-section-head">
                <h2>按格式</h2>
              </div>
              <div className="m2-chips is-wrap">
                {formatChips.map((q) => (
                  <button key={q} className="m2-chip" onClick={() => setSearchInput(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="m2-empty-line">搜索图包名或文件名，匹配不区分大小写。搜索记录只保存在本机。</p>
        </>
      );
    }
    if (searchFolders.length === 0 && searchImages.length === 0) {
      return (
        <div className="m2-empty-state">
          <MobileIcon name="search" className="w-7 h-7" />
          <strong>未找到匹配项</strong>
          <span>没有与「{searchQuery}」匹配的图包或文件</span>
        </div>
      );
    }
    return (
      <>
        {searchFolders.length > 0 && (
          <>
            <div className="m2-section-head">
              <h2>
                图包<span className="tabular-nums">{searchFolders.length}</span>
              </h2>
            </div>
            <div className="m2-pack-list">{searchFolders.map((f) => <div key={f.id}>{packCard(f, true)}</div>)}</div>
          </>
        )}
        {searchImages.length > 0 && (
          <>
            <div className="m2-section-head">
              <h2>
                图片<span className="tabular-nums">{searchImages.length}</span>
              </h2>
            </div>
            <RowGrid
              className="m2-image-grid"
              style={{ ['--m2-cell-radius' as string]: '8px' }}
              items={searchImages}
              cols={4}
              gap={imageGridGap(4)}
              getKey={(img) => img.id}
              renderItem={(img, i) => (
                <ImageCard
                  image={img}
                  index={i}
                  store={store}
                  blurred={blurredImages.has(img.relPath)}
                  showName
                  selectMode={false}
                  selected={false}
                  onOpen={() => {
                    rememberSearch();
                    openViewer(img);
                  }}
                  onToggleSelect={toggleSelect}
                  onLongPress={(image) => openImageActions(image)}
                />
              )}
            />
          </>
        )}
      </>
    );
  };

  // ===== 顶栏 =====
  const renderAppbar = () => {
    if (searchActive) {
      return (
        <header className="m2-appbar is-solid" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
          <div className="m2-appbar-row">
            <button className="m2-icon-button" onClick={closeSearch} aria-label="关闭搜索">
              <MobileIcon name="back" className="w-[22px] h-[22px]" />
            </button>
            <label className="m2-search-field">
              <MobileIcon name="search" className="w-[18px] h-[18px] shrink-0" />
              <input
                autoFocus
                placeholder="搜索图包或文件名"
                value={searchInput}
                enterKeyHint="search"
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    rememberSearch();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              {searchInput && (
                <button className="m2-icon-button is-small" onClick={() => setSearchInput('')} aria-label="清空">
                  <MobileIcon name="close" className="w-4 h-4" />
                </button>
              )}
            </label>
          </div>
        </header>
      );
    }
    if (selectMode) {
      return (
        <header className="m2-appbar is-solid" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
          <div className="m2-appbar-row">
            <button className="m2-icon-button" onClick={exitSelectMode} aria-label="退出多选">
              <MobileIcon name="close" className="w-[22px] h-[22px]" />
            </button>
            <div className="m2-appbar-title is-visible tabular-nums">
              已选 {selectedIds.size} 项<small>长按后拖动可连续选择</small>
            </div>
            <button
              className="m2-icon-button"
              onClick={handleSelectAll}
              aria-label={selectedIds.size === displayImages.length ? '取消全选' : '全选'}
              aria-pressed={selectedIds.size === displayImages.length && displayImages.length > 0}
            >
              <MobileIcon name="select-all" className="w-[22px] h-[22px]" />
            </button>
          </div>
        </header>
      );
    }
    const overHero = pageKind === 'folder' && !appbarSolid;
    return (
      <header className={`m2-appbar ${appbarSolid ? 'is-solid' : ''} ${overHero ? 'is-over-hero' : ''}`} style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="m2-appbar-row">
          {pageKind === 'folder' ? (
            <button className="m2-icon-button" onClick={goUp} aria-label="返回上级">
              <MobileIcon name="back" className="w-[22px] h-[22px]" />
            </button>
          ) : (
            <span className="w-3" aria-hidden="true" />
          )}
          <div className={`m2-appbar-title ${appbarSolid ? 'is-visible' : ''}`} aria-hidden={!appbarSolid}>
            {pageKind === 'folder' ? selectedFolder?.name : '图库'}
            {pageKind === 'folder' && <small className="tabular-nums">{displayImages.length} 张</small>}
          </div>
          <TaskButton tasks={tasks} unseen={tasksUnseen} onOpen={openTasks} />
          {pageKind === 'folder' ? (
            <button className="m2-icon-button" onClick={() => selectedFolder && openFolderActions(selectedFolder)} aria-label="更多操作">
              <MobileIcon name="more" className="w-[22px] h-[22px]" />
            </button>
          ) : (
            <>
              <button className="m2-icon-button" onClick={openDrawer} aria-label="目录树" disabled={!snapshot}>
                <MobileIcon name="tree" className="w-[22px] h-[22px]" />
              </button>
              <button className="m2-icon-button" onClick={() => openSettings()} aria-label="设置">
                <MobileIcon name="settings" className="w-[22px] h-[22px]" />
              </button>
            </>
          )}
        </div>
      </header>
    );
  };

  const hasRunningTask = tasks.some((t) => t.status === 'running');
  const floatingHidden = viewerOpen || keyboardOpen;
  const showFab = pageKind === 'library' && !selectMode && !floatingHidden && !!rootFolder && rootFolder.childCount > 0;
  const showPill = hasRunningTask && !selectMode && !floatingHidden && pageKind !== 'search';
  const showSelbar = selectMode && !floatingHidden;
  const canExportSelection = typeof store.zipSelection === 'function';

  return (
    <div className="mobile-studio m2-shell fixed inset-0 flex flex-col overflow-hidden">
      {renderAppbar()}

      <main
        ref={mainScrollRef}
        onScroll={onMainScroll}
        className={`m2-main flex-1 overflow-y-auto overscroll-contain relative is-${pageKind} ${selectMode ? 'is-selecting' : ''}`}
      >
        {(searchActive || (selectMode && pageKind !== 'folder')) && <div className="m2-appbar-spacer" aria-hidden="true" />}
        {!snapshot ? (
          loadError ? (
            <div className="m2-empty-state is-page">
              <MobileIcon name="refresh" className="w-7 h-7" />
              <strong>图库加载失败</strong>
              <span>{loadError}</span>
              <button className="m2-button is-primary" onClick={() => void loadLibrary()}>
                重试
              </button>
            </div>
          ) : (
            <div className="m2-empty-state is-page">
              <span className="m2-spinner is-large" aria-label="正在载入图库" />
            </div>
          )
        ) : pageKind === 'search' ? (
          renderSearch()
        ) : pageKind === 'library' ? (
          renderLibrary()
        ) : (
          renderFolder()
        )}
        <div className="m2-bottom-space" aria-hidden="true" />
      </main>

      {/* 多选浮动操作栏（键盘弹出时隐藏，避免被顶到键盘上沿悬浮） */}
      {showSelbar && (
        <div className="m2-selbar" style={{ zIndex: Z_BATCH_BAR }} role="toolbar" aria-label="所选图片操作">
          <button disabled={selectedIds.size === 0 || batchBusy} onClick={() => openPrompt({ kind: 'batch-move', count: selectedImages.length })}>
            <MobileIcon name="move" className="w-[22px] h-[22px]" />
            移动
          </button>
          <button
            disabled={selectedImages.length !== 1}
            onClick={() => {
              const img = selectedImages[0];
              if (!img) return;
              pinCover(coverTargetFor(img), img.id, img.name);
              exitSelectMode();
            }}
          >
            <MobileIcon name="image" className="w-[22px] h-[22px]" />
            设为封面
          </button>
          <button
            disabled={selectedIds.size === 0}
            onClick={() => {
              const allBlurred = selectedImages.every((img) => blurredImages.has(img.relPath));
              setImagesBlurred(selectedImages, !allBlurred);
              notify(allBlurred ? `已取消 ${selectedImages.length} 张的隐私预览` : `已模糊 ${selectedImages.length} 张`, 'success');
              exitSelectMode();
            }}
          >
            <MobileIcon name="eye-off" className="w-[22px] h-[22px]" />
            {selectedImages.length > 0 && selectedImages.every((img) => blurredImages.has(img.relPath)) ? '取消模糊' : '模糊'}
          </button>
          {canExportSelection && (
            <button
              disabled={selectedIds.size === 0 || exporting}
              onClick={() => {
                const targets = selectedImages;
                const name = `${selectedFolder?.name || '图库'}-已选${targets.length}张`;
                exitSelectMode();
                void runExport(`导出 ${targets.length} 张所选图片`, (onProgress, token) =>
                  store.zipSelection!(targets.map((img) => img.relPath), name, onProgress, token),
                );
              }}
            >
              <MobileIcon name="zip" className="w-[22px] h-[22px]" />
              导出
            </button>
          )}
          <button className="is-danger" disabled={selectedIds.size === 0 || batchBusy} onClick={handleBatchDelete}>
            <MobileIcon name="trash" className="w-[22px] h-[22px]" />
            删除
          </button>
        </div>
      )}

      {showPill && <ProgressPill tasks={tasks} onOpen={openTasks} wide={!showFab} />}

      {showFab && (
        <button
          className={`m2-fab ${fabCompact || hasRunningTask ? 'is-compact' : ''}`}
          disabled={importing}
          onClick={() => void handleImport()}
          aria-label="导入图包"
        >
          <MobileIcon name="plus" className="w-6 h-6" />
          <span>导入图包</span>
        </button>
      )}

      {/* 目录树 */}
      {drawerOpen && snapshot && (
        <FolderTreeSheet
          snapshot={snapshot}
          currentFolderId={currentFolderId}
          expanded={expandedFolders}
          refreshing={refreshing}
          onToggle={toggleFolderExpand}
          onRefresh={() => void handleRefresh()}
          onClose={() => closeOverlay('drawer')}
          onSelect={(id) => {
            if (id === snapshot.rootId && !isRoot) {
              // 回到根目录：逐级回退到栈底，而不是再压一层根目录。
              const depth = stackRef.current.filter((e) => e.type === 'folder').length;
              if (depth > 0) {
                stackRef.current = stackRef.current.filter((e) => e.type !== 'folder');
                window.history.go(-depth);
                selectedFolderIdRef.current = id;
                setSelectedFolderId(id);
                animatePage('back');
                return;
              }
            }
            navigateToFolder(id);
          }}
        />
      )}

      {/* 显示选项 / 图包排列 */}
      {displaySheet === 'images' && (
        <DisplaySheet
          viewMode={viewMode}
          onViewMode={(mode) => {
            setViewMode(mode);
            localStorage.setItem('kanitsu.viewMode', mode);
          }}
          cols={gridCols}
          onCols={(cols) => changeGridCols(cols)}
          sortMode={sortMode}
          onSortMode={setSortMode}
          sortDirection={sortDirection}
          onSortDirection={setSortDirection}
          showFileNames={showFileNames}
          onShowFileNames={(next) => {
            setShowFileNames(next);
            localStorage.setItem('kanitsu.showFileNames', next ? '1' : '0');
          }}
          aggregate={aggregate}
          onAggregate={setAggregate}
          childCount={selectedFolder?.childCount ?? 0}
          onClose={() => closeOverlay('display')}
        />
      )}
      {displaySheet === 'library' && <LibrarySortSheet prefs={libPrefs} onChange={updateLibPrefs} onClose={() => closeOverlay('display')} />}

      {/* 查看器 */}
      {viewerOpen && (
        <MobileViewer
          key={viewerSessionId}
          images={viewerImages}
          index={viewerIndex}
          store={store}
          blurredPaths={blurredImages}
          infoOpen={viewerInfoOpen}
          onInfoOpenChange={setViewerInfoOpen}
          onClose={() => closeOverlay('viewer')}
          onNavigate={(id) => setViewerImageId(id)}
          onShowActions={(img) => openImageActions(img, true)}
          onSetCover={(img) => pinCover(coverTargetFor(img), img.id, img.name)}
          onToggleBlur={toggleImageBlur}
          onDelete={(img) => openDelete({ kind: 'image', image: img })}
        />
      )}

      {/* 智能整理（两步全屏流程） */}
      {organizePresence.present && organizeFlowRef.current && snapshot && (
        <MobileOrganizeFlow
          folder={organizeFlowRef.current.folder}
          images={imagesOf(snapshot, organizeFlowRef.current.folder.id)}
          customRules={customRules}
          store={store}
          blurredPaths={blurredImages}
          step={organizeFlowRef.current.step}
          onStepChange={(step) => setOrganizeFlow((prev) => (prev ? { ...prev, step } : prev))}
          onApply={(bindings, ruleName) => void handleApplyOrganize(bindings, ruleName)}
          onClose={() => closeOverlay('organize')}
          onManageRules={() => openSettings('rules')}
          exiting={organizePresence.exiting}
        />
      )}

      {/* 封面选择（全屏化桌面组件） */}
      {coverPresence.present && coverFolderRef.current && snapshot && (() => {
        const coverFolder = coverFolderRef.current;
        return (
          <div className={`m-fullscreen ${coverPresence.exiting ? 'm-fade-exit' : ''}`}>
            <CoverPickerModal
              folderId={coverFolder.id}
              snapshot={snapshot}
              store={store}
              pinnedCovers={pinnedCovers}
              currentCoverId={pinnedCovers[coverFolder.id] ?? null}
              onPick={(imageId) => {
                const name = imageId ? snapshot.images[imageId]?.name : undefined;
                pinCover(coverFolder.id, imageId, name);
                closeOverlay('cover');
              }}
              onCancel={() => closeOverlay('cover')}
            />
          </div>
        );
      })()}

      {/* 任务中心 */}
      {tasksPresence.present && (
        <TasksScreen
          tasks={tasks}
          exiting={tasksPresence.exiting}
          onBack={() => closeOverlay('tasks')}
          onCancel={cancelTask}
          onUndo={(task) => void handleUndoOrganize(task.id)}
          onOpenFolder={(folderId) => {
            closeOverlay('tasks');
            if (snapshotRef.current?.folders[folderId]) navigateToFolder(folderId);
          }}
          onClear={() => setTasks((prev) => prev.filter((t) => t.status === 'running' || t.undoable))}
        />
      )}

      {/* 设置 */}
      {settingsPresence.present && (
        <MobileSettingsScreen
          rules={customRules}
          onChange={handleCustomRulesChange}
          onBack={() => closeOverlay('settings')}
          section={settingsSection}
          onSectionChange={setSettingsSection}
          exiting={settingsPresence.exiting}
        />
      )}

      {/* 动作面板 */}
      {sheet && (
        <MobileActionSheet
          title={sheet.title}
          subtitle={sheet.subtitle}
          media={
            sheet.media ? (
              <BlobImage
                store={store}
                fileRef={imageToFileRef(sheet.media)}
                alt=""
                className="w-full h-full object-cover"
                thumbnail
                blur={isImageBlurred(sheet.media.relPath, blurredImages)}
              />
            ) : undefined
          }
          quickActions={sheet.quickActions}
          actions={sheet.actions}
          onClose={() => closeOverlay('sheet')}
        />
      )}

      {/* 删除确认 + 输入对话框（共用退场动画；退场期间数据已置空，用 ref 里的最后一份内容渲染，避免空壳瞬灭） */}
      {dialogPresence.present && (() => {
        const dialogDelete = deleteTarget ?? deleteTargetRef.current;
        const dialogPrompt = promptState ?? promptStateRef.current;
        return (
          <div className={dialogPresence.exiting ? 'm-fade-exit' : ''} style={{ position: 'relative', zIndex: Z_DIALOG }}>
            {dialogDelete && (
              <MobileConfirmDialog
                title={
                  dialogDelete.kind === 'image'
                    ? `删除「${dialogDelete.image.name}」？`
                    : dialogDelete.kind === 'folder'
                      ? `删除「${dialogDelete.folder.name}」？`
                      : `删除 ${dialogDelete.count} 张图片？`
                }
                body={
                  dialogDelete.kind === 'folder'
                    ? `将从图库删除 ${dialogDelete.folder.imageCount} 张图片副本及全部子目录。源文件夹不受影响，但此操作无法撤销。`
                    : '只删除图库中的副本，源文件夹不受影响。此操作无法撤销。'
                }
                confirmLabel={dialogDelete.kind === 'batch' ? `删除 ${dialogDelete.count} 张` : '删除'}
                onConfirm={() => void handleDeleteConfirm()}
                onCancel={() => closeOverlay('dialog')}
              />
            )}

            {/* 输入对话框 */}
            {dialogPrompt && (
              <MobilePromptDialog
                title={
                  dialogPrompt.kind === 'rename-image'
                    ? '重命名图片'
                    : dialogPrompt.kind === 'rename-folder'
                      ? '重命名图包'
                      : dialogPrompt.kind === 'batch-move'
                        ? `移动 ${dialogPrompt.count} 张图片到新文件夹`
                        : `在「${dialogPrompt.folder.name || '图库'}」中新建子目录`
                }
                label={dialogPrompt.kind === 'create-folder' || dialogPrompt.kind === 'batch-move' ? '文件夹名称' : '新名称'}
                initialValue={
                  dialogPrompt.kind === 'rename-image'
                    ? dialogPrompt.image.name
                    : dialogPrompt.kind === 'rename-folder'
                      ? dialogPrompt.folder.name
                      : ''
                }
                confirmLabel={dialogPrompt.kind === 'create-folder' || dialogPrompt.kind === 'batch-move' ? '创建' : '保存'}
                onSubmit={(v) => void handlePromptSubmit(v)}
                onCancel={() => closeOverlay('dialog')}
              />
            )}
          </div>
        );
      })()}

      {/* Snackbar（查看器打开时也显示：Z_TOAST 本就高于查看器层级） */}
      {toast && (
        <MobileToast
          text={toast.text}
          kind={toast.kind}
          action={toast.action}
          onDismiss={() => setToast(null)}
          lifted={!viewerOpen && (showSelbar || showFab || showPill)}
        />
      )}
    </div>
  );
}
