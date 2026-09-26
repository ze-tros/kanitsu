/**
 * 桌面端（Electron / Web 演示）图库界面的容器组件：持有数据、偏好与全部业务操作，
 * 界面拆分在 ./desktop/ 下（对应 docs/kanitsu-desktop-redesign-demo.html）。
 *
 * 布局：标题栏 → 侧栏 | 主区（首页 / 图包页 / 设置） | 检查器；浮层有查看器、
 * 命令面板、任务中心、对话框、右键菜单与 Snackbar。长操作（导入 / 整理 / 导出 /
 * 移动 / 删除）统一以任务呈现，整理与移动可撤销最近一次。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsLeftRight,
  CaretDown,
  CaretRight,
  CheckSquare,
  Copy,
  Eye,
  EyeSlash,
  FileZip,
  FolderOpen,
  FolderPlus,
  GearSix,
  ImageSquare,
  Keyboard,
  List,
  ListChecks,
  MagicWand,
  MagnifyingGlass,
  Moon,
  PencilSimple,
  PushPin,
  Rows,
  SidebarSimple,
  SquaresFour,
  Stack,
  Sun,
  Tag,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import {
  applyOrganize,
  childrenOf,
  createSubfolder,
  deleteImage,
  deleteLibraryFolder,
  directImagesOf,
  imagesOf,
  importFolder,
  joinRelPath,
  loadOrScan,
  mergeIntoNewPack,
  moveEntries,
  readSnapshotMirror,
  renameFolder,
  renameImage,
  rescanLibrary,
  undoOrganize,
  writeSnapshotMirror,
  type FolderNode,
  type ImageEntry,
  type LibrarySnapshot,
  type OrganizeBinding,
  type OrganizeManifest,
  type PersistentIndex,
} from '../../core/src/index';
import type { FileRef, FolderRef, ImportSourcePicker, LibraryStore } from '../../fs-adapter/src/types';
import type { DesktopRawViewMode } from '../../fs-adapter/src/electron';
import type { CustomOrganizeRule } from '../../organizer/src/index';
import { pickCover } from '../../cover-picker/src/index';
import {
  COVER_THUMBNAIL_SIZE,
  preloadThumbnails,
  THUMB_PRIORITY_CURRENT_DIR,
  THUMB_PRIORITY_DIRECTIONAL,
  THUMB_PRIORITY_SUBFOLDER,
  THUMB_PRIORITY_WARMUP,
  setThumbnailPreloadPaused,
} from './thumbnailCache';
import { getLogLevelPref, isPrefetchEnabled, logDebug } from './debugLog';
import {
  backTarget,
  canGoBack,
  canGoForward,
  createNavHistory,
  forwardTarget,
  moveBack,
  moveForward,
  recordNav,
  type NavHistory,
} from './navHistory';
import { ContextMenu, type ContextMenuItem, type ContextMenuModel } from './ContextMenu';
import { loadCustomRules, saveCustomRules } from './OrganizeRulesModal';
import { DEFAULT_ACCENT, isAccentMode } from './accents';
import { SettingsPage, type AccentOption, type ThemeOption } from './SettingsPage';
import type { SettingsTabId } from './settingsTabs';
import {
  browseFolderFor,
  formatRelativeTime,
  loadImportedAt,
  loadRecentBrowse,
  pruneImportedAt,
  recordRecentBrowse,
  resolveContinueItems,
  saveImportedAt,
  saveRecentBrowse,
  RECENT_IMPORT_WINDOW_MS,
  type ImportedAtMap,
  type RecentBrowseEntry,
} from './browseHistory';
import { AUTO_RULE_ID, bindingsForRule, planBindings, previewGroups, ruleOptions } from './organizePlan';
import {
  gridLayout,
  itemsInRect,
  justifiedLayout,
  listLayout,
  neighborIndex,
  type GalleryLayout,
  type ItemBox,
  type NavKey,
} from './desktop/galleryLayout';
import { VirtualSurface, type SurfaceWindow } from './desktop/VirtualSurface';
import {
  ImageCell,
  ImageListRow,
  PackCard,
  PackListRow,
  IMAGE_CAPTION_H,
  IMAGE_LIST_ROW_H,
  PACK_CAPTION_H,
  PACK_LIST_ROW_H,
  PACK_STACK_H,
  type PackCardData,
} from './desktop/cards';
import {
  ContinueBrowsing,
  EmptyState,
  FirstRun,
  HomeHeader,
  ImageToolbar,
  ListHeader,
  type ListColumn,
  PackHero,
  PackViewControls,
  SectionHeader,
  SelectionBar,
  StatusBar,
  SubPackStrip,
  SUBPACK_STRIP_LIMIT,
  type ContinueCardData,
  type SubPackData,
} from './desktop/pageParts';
import { Inspector, type OrganizeHint } from './desktop/Inspector';
import { Sidebar } from './desktop/Sidebar';
import { TitleBar } from './desktop/TitleBar';
import { TaskButton, TaskPopover, type DesktopTask } from './desktop/TaskCenter';
import { Snackbar, type SnackAction, type SnackMessage } from './desktop/Snackbar';
import { CommandPalette, type PaletteCommand } from './desktop/CommandPalette';
import { OrganizeDialog, organizeIncludesSubfoldersByDefault } from './desktop/OrganizeDialog';
import { CoverDialog, DeleteDialog, MoveDialog, PromptDialog, ShortcutsDialog, type DeleteRequest, type PromptOptions } from './desktop/Dialogs';
import { DropOverlay } from './desktop/DropOverlay';
import { Viewer } from './desktop/Viewer';
import {
  COVER_SIZE,
  THUMB_SIZE,
  formatBytes,
  formatCount,
  imageFileRef,
  loadViewPrefs,
  saveViewPrefs,
  sortImages,
  validateEntryName,
  IMAGE_SORT_LABELS,
  PACK_SORT_LABELS,
  type DesktopViewPrefs,
  type ImageSort,
  type LibraryFilter,
  type PackSort,
} from './desktop/shared';
import { loadBlurredImages, loadPinnedCovers, saveBlurredImages, savePinnedCovers } from './libraryPrefs';


type ResolvedTheme = 'light' | 'dark';

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 子文件夹预览图预加载参数：进入某文件夹时，为每个子文件夹的前若干张
// 缩略图预热缓存，点进子文件夹时网格立即可用。
const PRELOAD_PER_FOLDER = 12;
const PRELOAD_MAX_FOLDERS = 16;

/** 主区左右留白（与 .dk-grid-area 的 padding 一致），布局宽度 = 容器宽度 - 2 × 该值。 */
const CONTENT_PAD_X = 32;
const PACK_GAP = 20;
const NARROW_WIDTH = 1180;
const COMPACT_WIDTH = 980;
const VIEWER_IDLE_MS = 2600;
const CONTINUE_LIMIT = 4;
/** 检查器「可整理」提示最多解析的图片数。 */
const ORGANIZE_HINT_MAX = 4000;

// 列表视图表头：列顺序与 desktop/cards 的列表行一致（空 label 为复选框 / 缩略图 / 操作列）。
const PACK_LIST_COLUMNS: ReadonlyArray<ListColumn<PackSort>> = [
  { label: '' }, { label: '' }, { label: '名称', sort: 'name' }, { label: '图片', sort: 'count' },
  { label: '子图包' }, { label: '占用', sort: 'size' }, { label: '导入时间', sort: 'recent' }, { label: '' },
];
const IMAGE_LIST_COLUMNS: ReadonlyArray<ListColumn<ImageSort>> = [
  { label: '' }, { label: '' }, { label: '名称', sort: 'name' }, { label: '尺寸', sort: 'dims' },
  { label: '格式' }, { label: '大小', sort: 'size' }, { label: '修改时间', sort: 'modified' },
];

const folderKey = (id: string) => `f:${id}`;
const isFolderKey = (key: string) => key.startsWith('f:');

function gridGap(thumbSize: number): number {
  return thumbSize < 120 ? 6 : thumbSize < 190 ? 10 : 14;
}
function gridRadius(thumbSize: number): number {
  return thumbSize < 120 ? 6 : thumbSize < 190 ? 9 : 12;
}

type DialogState =
  | { kind: 'prompt'; options: PromptOptions }
  | { kind: 'delete'; request: DeleteRequest }
  | { kind: 'move'; imageIds: string[]; folderIds: string[] }
  | { kind: 'cover'; folderId: string }
  | { kind: 'organize'; folderId: string; ruleId?: string }
  | { kind: 'shortcuts' }
  | null;

/** 可撤销的最近一次移动（整理 / 移动 / 合并）。 */
interface UndoEntry {
  taskId: string;
  kind: 'organize' | 'move' | 'merge';
  manifest: OrganizeManifest;
}

const UNDO_LABEL: Record<UndoEntry['kind'], string> = { organize: '撤销上次整理', move: '撤销上次移动', merge: '撤销上次合并' };

export function LibraryBrowser({
  picker,
  store,
  index,
  enableRaw,
  enableHeif,
}: {
  picker: ImportSourcePicker;
  store: LibraryStore;
  index: PersistentIndex;
  /** 是否收录主流相机 RAW(桌面开启;需配套平台解码管线支持)。 */
  enableRaw?: boolean;
  /** 是否收录 HEIF/HEIC 容器(桌面/Android 开启;需配套平台解码管线支持)。 */
  enableHeif?: boolean;
}) {
  // ———————————————————— 数据 ————————————————————
  // 首帧同步水合：localStorage 读取是同步的，能在首次渲染前拿到上次会话的图库结构；
  // loadOrScan 完成后仍会用权威数据整体覆盖。
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(readSnapshotMirror);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  const mirrorKeyRef = useRef('');
  const scanOptions = useMemo(() => ({ enableRaw: enableRaw ?? false, enableHeif: enableHeif ?? false }), [enableRaw, enableHeif]);

  const applySnapshot = useCallback((next: LibrarySnapshot) => {
    setSnapshot(next);
    setSelectedFolderId((prev) => (prev && next.folders[prev] ? prev : next.rootId));
    const mirrorKey = `${next.fingerprint}|${Object.keys(next.folders).length}|${Object.keys(next.images).length}`;
    if (mirrorKey !== mirrorKeyRef.current) {
      mirrorKeyRef.current = mirrorKey;
      writeSnapshotMirror(next);
    }
  }, []);

  useEffect(() => {
    void (async () => applySnapshot(await loadOrScan(store, index, scanOptions)))();
  }, [store, index, applySnapshot, scanOptions]);

  const refresh = useCallback(async () => {
    const next = await rescanLibrary(store, index, scanOptions);
    applySnapshot(next);
    return next;
  }, [store, index, applySnapshot, scanOptions]);

  // ———————————————————— 偏好 ————————————————————
  const [prefs, setPrefs] = useState<DesktopViewPrefs>(loadViewPrefs);
  const setPref = useCallback(<K extends keyof DesktopViewPrefs>(key: K, value: DesktopViewPrefs[K]) => {
    setPrefs((prev) => {
      if (prev[key] === value) return prev;
      const next = { ...prev, [key]: value };
      saveViewPrefs(next);
      return next;
    });
  }, []);

  const [theme, setTheme] = useState<ThemeOption>(() => {
    const saved = localStorage.getItem('kanitsu-theme');
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
  });
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  );
  const [accent, setAccent] = useState<AccentOption>(() => {
    const saved = localStorage.getItem('kanitsu-accent');
    return isAccentMode(saved) ? saved : DEFAULT_ACCENT;
  });
  const effectiveTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? 'light' : 'dark');
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
    document.documentElement.dataset.accent = accent;
    document.documentElement.style.colorScheme = effectiveTheme;
    try {
      localStorage.setItem('kanitsu-theme', theme);
      localStorage.setItem('kanitsu-accent', accent);
    } catch {
      // Ignore storage errors.
    }
  }, [accent, effectiveTheme, theme]);

  const [rawViewMode, setRawViewMode] = useState<DesktopRawViewMode>(() =>
    localStorage.getItem('kanitsu-raw-view-mode') === 'camera' ? 'camera' : 'developed',
  );
  // RAW 查看模式:localStorage 镜像供 fs-adapter 同步读取;主进程 settings.json 是持久事实源。
  // 切换时同步写镜像并推送主进程——子组件(Viewer 取 URL)的 effect 先于父组件运行,
  // 同步落盘才能让切换后的首次 getViewerUrl 读到新模式。
  const handleRawViewModeChange = useCallback((mode: DesktopRawViewMode) => {
    setRawViewMode(mode);
    try {
      localStorage.setItem('kanitsu-raw-view-mode', mode);
    } catch {
      // Ignore storage errors.
    }
    void window.kanitsuDesktop?.setRawViewMode?.(mode)?.catch?.(() => undefined);
  }, []);
  // 用主进程持久值校准一次，避免 localStorage 被清理后界面与解码侧脱节。
  useEffect(() => {
    let cancelled = false;
    void window.kanitsuDesktop
      ?.getRawViewMode?.()
      .then((mode) => {
        if (!cancelled && (mode === 'camera' || mode === 'developed')) setRawViewMode(mode);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 启动时把本地保存的日志等级同步给主进程。
  useEffect(() => {
    void window.kanitsuDesktop?.setLogLevel?.(getLogLevelPref());
  }, []);

  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const narrow = windowWidth < NARROW_WIDTH;
  const compact = windowWidth < COMPACT_WIDTH;

  const [sidebarHidden, setSidebarHidden] = useState(() => window.innerWidth < COMPACT_WIDTH || localStorage.getItem('kanitsu-sidebar-hidden') === '1');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const value = Number(localStorage.getItem('kanitsu-sidebar-width'));
    return Number.isFinite(value) && value >= 200 ? Math.min(value, 360) : 244;
  });
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem('kanitsu-inspector-open') !== '0' && window.innerWidth >= NARROW_WIDTH);
  useEffect(() => {
    try {
      localStorage.setItem('kanitsu-sidebar-hidden', sidebarHidden ? '1' : '0');
      localStorage.setItem('kanitsu-sidebar-width', String(sidebarWidth));
      localStorage.setItem('kanitsu-inspector-open', inspectorOpen ? '1' : '0');
    } catch {
      // Ignore storage errors.
    }
  }, [inspectorOpen, sidebarHidden, sidebarWidth]);
  // 进入窄窗口时收起浮层式的侧栏 / 检查器，避免盖住内容。
  const prevNarrowRef = useRef({ narrow, compact });
  useEffect(() => {
    const prev = prevNarrowRef.current;
    if (compact && !prev.compact) setSidebarHidden(true);
    if (narrow && !prev.narrow) setInspectorOpen(false);
    prevNarrowRef.current = { narrow, compact };
  }, [compact, narrow]);

  const [customRules, setCustomRules] = useState<CustomOrganizeRule[]>(() => loadCustomRules());
  const handleCustomRulesChange = useCallback((rules: CustomOrganizeRule[]) => {
    setCustomRules(rules);
    saveCustomRules(rules);
  }, []);

  // ———————————————————— 本机记录 ————————————————————
  const [pinnedCovers, setPinnedCovers] = useState<Record<string, string>>(() => loadPinnedCovers());
  const [blurredImages, setBlurredImages] = useState<ReadonlySet<string>>(() => loadBlurredImages());
  const [importedAt, setImportedAt] = useState<ImportedAtMap>(() => loadImportedAt());
  const [recentBrowse, setRecentBrowse] = useState<RecentBrowseEntry[]>(() => loadRecentBrowse());
  /** 本次会话新导入、尚未打开过的顶层图包。 */
  const [freshFolders, setFreshFolders] = useState<ReadonlySet<string>>(new Set());
  /** 隐私预览图片在查看器里「本次显示」过的 id。 */
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!snapshot) return;
    setImportedAt((prev) => {
      const next = pruneImportedAt(snapshot, prev);
      if (next !== prev) saveImportedAt(next);
      return next;
    });
  }, [snapshot]);

  // ———————————————————— 视图状态 ————————————————————
  const [libFilter, setLibFilter] = useState<LibraryFilter>('all');
  const [filterText, setFilterText] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [subpacksExpanded, setSubpacksExpanded] = useState(false);
  const [nav, setNav] = useState<NavHistory>(() => createNavHistory());
  const lastRecordedFolderRef = useRef<string | null>(null);

  // ———————————————————— 浮层 ————————————————————
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [viewerList, setViewerList] = useState<ImageEntry[] | null>(null);
  const [viewerInfoOpen, setViewerInfoOpen] = useState(false);
  const [filmstripVisible, setFilmstripVisible] = useState(() => localStorage.getItem('kanitsu-filmstrip') !== '0');
  const [viewerIdle, setViewerIdle] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuModel | null>(null);
  const [palette, setPalette] = useState<{ query: string } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [settings, setSettings] = useState<{ tab?: SettingsTabId } | null>(null);
  const [snack, setSnack] = useState<SnackMessage | null>(null);
  const snackIdRef = useRef(0);
  const [dragCount, setDragCount] = useState(0);

  const [tasks, setTasks] = useState<DesktopTask[]>([]);
  const [taskPopoverOpen, setTaskPopoverOpen] = useState(false);
  const [taskReportOpen, setTaskReportOpen] = useState<ReadonlySet<string>>(new Set());
  const [tasksUnseen, setTasksUnseen] = useState(false);
  const taskCancelRef = useRef(new Map<string, () => void>());
  const taskSeqRef = useRef(0);
  const [lastUndo, setLastUndo] = useState<UndoEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const importingRef = useRef(false);
  const exportingRef = useRef(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const libraryRootRef = useRef<HTMLDivElement>(null);
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const taskButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarSentinelRef = useRef<HTMLDivElement>(null);
  const imageSurfaceRef = useRef<HTMLDivElement | null>(null);
  const packSurfaceRef = useRef<HTMLDivElement | null>(null);

  // ———————————————————— 提示 ————————————————————
  const notify = useCallback((text: string, kind?: SnackMessage['kind'], actions?: SnackAction[]) => {
    if (!text) {
      setSnack(null);
      return;
    }
    const detected = kind ?? (/失败|错误/.test(text) ? 'error' : /完成|成功|^已/.test(text) ? 'success' : 'info');
    snackIdRef.current += 1;
    setSnack({ id: snackIdRef.current, text, kind: detected, actions });
  }, []);
  useEffect(() => {
    if (!snack) return;
    const t = window.setTimeout(() => setSnack(null), snack.actions?.length ? 8000 : 4000);
    return () => window.clearTimeout(t);
  }, [snack]);

  // ———————————————————— 任务 ————————————————————
  const startTask = useCallback((task: Omit<DesktopTask, 'id' | 'status' | 'done' | 'total' | 'startedAt'> & { total?: number }) => {
    taskSeqRef.current += 1;
    const id = `t${taskSeqRef.current}`;
    setTasks((prev) => [{ id, status: 'running' as const, done: 0, startedAt: Date.now(), ...task, total: task.total ?? 0 }, ...prev].slice(0, 40));
    return id;
  }, []);
  const patchTask = useCallback((id: string, patch: Partial<DesktopTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);
  const taskPopoverOpenRef = useRef(false);
  taskPopoverOpenRef.current = taskPopoverOpen;
  const finishTask = useCallback((id: string, status: DesktopTask['status'], patch: Partial<DesktopTask> = {}) => {
    taskCancelRef.current.delete(id);
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch, status, cancelable: false, finishedAt: Date.now() } : t)));
    if (!taskPopoverOpenRef.current) setTasksUnseen(true);
  }, []);
  const dropTask = useCallback((id: string) => {
    taskCancelRef.current.delete(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const runningTask = tasks.find((t) => t.status === 'running') ?? null;

  // ———————————————————— 派生数据 ————————————————————
  const rootId = snapshot?.rootId ?? '';
  const currentFolderId = selectedFolderId || rootId;
  const isRoot = !snapshot || currentFolderId === rootId;
  const selectedFolder = snapshot?.folders[currentFolderId] ?? null;
  const topFolders = useMemo(() => (snapshot ? childrenOf(snapshot, snapshot.rootId) : []), [snapshot]);
  const allImages = useMemo(() => (snapshot ? Object.values(snapshot.images) : []), [snapshot]);
  const libraryBytes = useMemo(() => allImages.reduce((sum, image) => sum + image.size, 0), [allImages]);
  const isEmptyLibrary = !!snapshot && topFolders.length === 0 && allImages.length === 0;

  /** 每个目录（含子目录）的占用字节：一次遍历，把图片大小累加到所有祖先目录。 */
  const folderBytes = useMemo(() => {
    const map = new Map<string, number>();
    if (!snapshot) return map;
    for (const image of Object.values(snapshot.images)) {
      let id: string | null = image.folderId;
      while (id) {
        map.set(id, (map.get(id) ?? 0) + image.size);
        id = snapshot.folders[id]?.parentId ?? null;
      }
    }
    return map;
  }, [snapshot]);

  /** 目录封面（固定封面优先，否则智能挑选），按需计算并缓存到下次快照 / 固定封面变化。 */
  const coverFor = useMemo(() => {
    const cache = new Map<string, ImageEntry | null>();
    return (folderId: string): ImageEntry | null => {
      if (!snapshot) return null;
      const hit = cache.get(folderId);
      if (hit !== undefined) return hit;
      const picked = pickCover(imagesOf(snapshot, folderId), { preferredId: pinnedCovers[folderId] });
      const image = picked ? snapshot.images[picked.imageId] ?? null : null;
      cache.set(folderId, image);
      return image;
    };
  }, [snapshot, pinnedCovers]);

  const topImportedLabel = useCallback((folderId: string): string | undefined => {
    const ts = importedAt[folderId];
    return ts ? formatRelativeTime(ts) : undefined;
  }, [importedAt]);

  // 「最近导入」时间窗随导入记录一起刷新（导入后立即出现在筛选里）。
  const recentCutoff = useMemo(() => Date.now() - RECENT_IMPORT_WINDOW_MS, [importedAt]);
  const filterCounts = useMemo<Record<LibraryFilter, number>>(() => ({
    all: topFolders.length,
    recent: topFolders.filter((f) => (importedAt[f.id] ?? 0) >= recentCutoff).length,
    pinned: topFolders.filter((f) => pinnedCovers[f.id] != null).length,
  }), [importedAt, pinnedCovers, recentCutoff, topFolders]);

  const sortPacks = useCallback((folders: FolderNode[], sort: PackSort): FolderNode[] => {
    const byName = (a: FolderNode, b: FolderNode) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    const list = [...folders];
    if (sort === 'name') return list.sort(byName);
    if (sort === 'count') return list.sort((a, b) => b.imageCount - a.imageCount || byName(a, b));
    if (sort === 'size') return list.sort((a, b) => (folderBytes.get(b.id) ?? 0) - (folderBytes.get(a.id) ?? 0) || byName(a, b));
    // 最近导入：有导入记录的按时间倒序在前，其余按名称。
    return list.sort((a, b) => (importedAt[b.id] ?? 0) - (importedAt[a.id] ?? 0) || byName(a, b));
  }, [folderBytes, importedAt]);

  const packCardData = useCallback((folder: FolderNode): PackCardData => ({
    folder,
    cover: coverFor(folder.id),
    pinned: pinnedCovers[folder.id] != null,
    bytes: folderBytes.get(folder.id) ?? 0,
    importedLabel: folder.parentId === rootId ? topImportedLabel(folder.id) : undefined,
    fresh: freshFolders.has(folder.id),
  }), [coverFor, folderBytes, freshFolders, pinnedCovers, rootId, topImportedLabel]);

  /** 首页图包（按筛选与排序）。 */
  const homePacks = useMemo(() => {
    if (!isRoot) return [];
    let list = topFolders;
    if (libFilter === 'recent') list = list.filter((f) => (importedAt[f.id] ?? 0) >= recentCutoff);
    if (libFilter === 'pinned') list = list.filter((f) => pinnedCovers[f.id] != null);
    return sortPacks(list, libFilter === 'recent' ? 'recent' : prefs.packSort).map(packCardData);
  }, [importedAt, isRoot, libFilter, packCardData, pinnedCovers, prefs.packSort, recentCutoff, sortPacks, topFolders]);

  /** 图包页的子图包（按名称）。 */
  const subPacks = useMemo(() => {
    if (isRoot || !snapshot) return [];
    return sortPacks(childrenOf(snapshot, currentFolderId), 'name').map(packCardData);
  }, [currentFolderId, isRoot, packCardData, snapshot, sortPacks]);

  const packItems = isRoot ? homePacks : subpacksExpanded ? subPacks : [];

  /** 图包页的图片（含子目录开关、网格筛选、排序）。 */
  const galleryImages = useMemo(() => {
    if (!snapshot || isRoot) return [];
    const base = prefs.includeSubfolders ? imagesOf(snapshot, currentFolderId) : directImagesOf(snapshot, currentFolderId);
    const q = filterText.trim().toLowerCase();
    const filtered = q ? base.filter((image) => image.name.toLowerCase().includes(q)) : base;
    return sortImages(filtered, prefs.sort, prefs.sortDir);
  }, [currentFolderId, filterText, isRoot, prefs.includeSubfolders, prefs.sort, prefs.sortDir, snapshot]);

  const folderAllImages = useMemo(
    () => (snapshot ? (isRoot ? allImages : imagesOf(snapshot, currentFolderId)) : []),
    [allImages, currentFolderId, isRoot, snapshot],
  );

  const crumbs = useMemo(() => {
    if (!snapshot || !selectedFolder) return [];
    const chain: FolderNode[] = [];
    let node: FolderNode | undefined = selectedFolder;
    while (node && node.parentId) {
      chain.unshift(node);
      node = snapshot.folders[node.parentId];
    }
    return chain;
  }, [snapshot, selectedFolder]);

  // 选择集按快照解析（被删除 / 移走的项自动剔除）。
  const selectedImages = useMemo(() => {
    if (!snapshot || selection.size === 0) return [];
    const out: ImageEntry[] = [];
    for (const key of selection) if (!isFolderKey(key) && snapshot.images[key]) out.push(snapshot.images[key]!);
    return out;
  }, [selection, snapshot]);
  const selectedFolders = useMemo(() => {
    if (!snapshot || selection.size === 0) return [];
    const out: FolderNode[] = [];
    for (const key of selection) if (isFolderKey(key) && snapshot.folders[key.slice(2)]) out.push(snapshot.folders[key.slice(2)]!);
    return out;
  }, [selection, snapshot]);
  const selectionCount = selectedImages.length + selectedFolders.length;
  const selectedFolderStats = useMemo(() => {
    let images = 0;
    let bytes = 0;
    let childFolders = 0;
    for (const folder of selectedFolders) {
      images += folder.imageCount;
      bytes += folderBytes.get(folder.id) ?? 0;
      childFolders += folder.childCount;
    }
    return { images, bytes, childFolders };
  }, [folderBytes, selectedFolders]);
  const selectionBlurTargets = useMemo(() => {
    const relPaths = new Set(selectedImages.map((image) => image.relPath));
    if (snapshot) for (const folder of selectedFolders) for (const image of imagesOf(snapshot, folder.id)) relPaths.add(image.relPath);
    return relPaths;
  }, [selectedFolders, selectedImages, snapshot]);
  const selectionAllBlurred = selectionBlurTargets.size > 0 && [...selectionBlurTargets].every((p) => blurredImages.has(p));

  // 切换目录 / 筛选时清空选择与焦点，并收起展开的子图包网格。
  useEffect(() => {
    setSelection(new Set());
    anchorRef.current = null;
    setFocusKey(null);
    setSubpacksExpanded(false);
    setFilterText('');
  }, [currentFolderId, libFilter]);
  useEffect(() => {
    setSelection(new Set());
    anchorRef.current = null;
  }, [filterText, prefs.includeSubfolders]);
  // 快照更新后剔除已不存在的选择项。
  useEffect(() => {
    if (!snapshot) return;
    setSelection((current) => {
      if (current.size === 0) return current;
      const next = new Set([...current].filter((key) => (isFolderKey(key) ? snapshot.folders[key.slice(2)] : snapshot.images[key])));
      return next.size === current.size ? current : next;
    });
  }, [snapshot]);

  // ———————————————————— 导航 ————————————————————
  useEffect(() => {
    const current = selectedFolderId || snapshot?.rootId || '';
    if (!current || current === lastRecordedFolderRef.current) return;
    lastRecordedFolderRef.current = current;
    setNav((prev) => recordNav(prev, current));
  }, [selectedFolderId, snapshot]);

  const scrollPositionsRef = useRef(new Map<string, number>());
  const routeKey = settings ? 'settings' : isRoot ? `root:${libFilter}` : `f:${currentFolderId}`;
  const routeKeyRef = useRef(routeKey);

  const selectFolder = useCallback((folderId: string) => {
    const main = mainScrollRef.current;
    if (main) scrollPositionsRef.current.set(routeKeyRef.current, main.scrollTop);
    setSettings(null);
    setSelectedFolderId(folderId);
    setFreshFolders((prev) => {
      if (!prev.has(folderId)) return prev;
      const next = new Set(prev);
      next.delete(folderId);
      return next;
    });
    const snap = snapshotRef.current;
    const folder = snap?.folders[folderId];
    if (snap && folder) {
      // 展开到当前目录的所有祖先，侧栏里能看到选中行。
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        let parent = folder.parentId;
        while (parent && parent !== snap.rootId) {
          next.add(parent);
          parent = snap.folders[parent]?.parentId ?? null;
        }
        if (folder.childCount > 0) next.add(folder.id);
        return next.size === prev.size ? prev : next;
      });
    }
    if (window.innerWidth < COMPACT_WIDTH) setSidebarHidden(true);
  }, []);

  const openFolder = useCallback((folder: FolderNode) => selectFolder(folder.id), [selectFolder]);
  const goRoot = useCallback((filter: LibraryFilter = 'all') => {
    setLibFilter(filter);
    if (snapshotRef.current) selectFolder(snapshotRef.current.rootId);
  }, [selectFolder]);

  const handleNavBack = useCallback(() => {
    if (settings) {
      setSettings(null);
      return;
    }
    const target = backTarget(nav);
    if (target && snapshot?.folders[target]) {
      lastRecordedFolderRef.current = target;
      selectFolder(target);
    }
    setNav((prev) => moveBack(prev));
  }, [nav, selectFolder, settings, snapshot]);

  const handleNavForward = useCallback(() => {
    const target = forwardTarget(nav);
    if (target && snapshot?.folders[target]) {
      lastRecordedFolderRef.current = target;
      selectFolder(target);
    }
    setNav((prev) => moveForward(prev));
  }, [nav, selectFolder, snapshot]);

  const toggleFolderExpanded = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ———————————————————— 主区滚动 / 尺寸 ————————————————————
  const [contentWidth, setContentWidth] = useState(0);
  const [toolbarStuck, setToolbarStuck] = useState(false);
  useLayoutEffect(() => {
    const main = mainScrollRef.current;
    if (!main) return;
    const measure = () => setContentWidth(Math.max(1, main.clientWidth - CONTENT_PAD_X * 2));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    return () => ro.disconnect();
  }, [settings, isEmptyLibrary]);

  // 滚动中给主区加 .dk-scrolling 并暂停后台预热（只保留可见与下一屏）。
  useEffect(() => {
    const main = mainScrollRef.current;
    if (!main) return;
    let timer: number | null = null;
    let frame: number | null = null;
    const native = 'onscrollend' in main;
    const end = () => {
      main.classList.remove('dk-scrolling');
      setThumbnailPreloadPaused(false);
    };
    const onScroll = () => {
      main.classList.add('dk-scrolling');
      setThumbnailPreloadPaused(true);
      if (!native) {
        if (timer != null) window.clearTimeout(timer);
        timer = window.setTimeout(end, 180);
      }
      if (frame == null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          scrollPositionsRef.current.set(routeKeyRef.current, main.scrollTop);
        });
      }
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    if (native) main.addEventListener('scrollend', end);
    return () => {
      main.removeEventListener('scroll', onScroll);
      if (native) main.removeEventListener('scrollend', end);
      if (timer != null) window.clearTimeout(timer);
      if (frame != null) cancelAnimationFrame(frame);
      end();
    };
  }, [settings, isEmptyLibrary]);

  // 切换路由后恢复该页的滚动位置（布局高度由宽度同步算出，首帧即可恢复）。
  useLayoutEffect(() => {
    routeKeyRef.current = routeKey;
    const main = mainScrollRef.current;
    if (main) main.scrollTop = scrollPositionsRef.current.get(routeKey) ?? 0;
  }, [routeKey]);

  // 吸顶工具栏：哨兵离开视口即视为吸顶，显示图包名。
  useEffect(() => {
    const sentinel = toolbarSentinelRef.current;
    const main = mainScrollRef.current;
    if (!sentinel || !main) {
      setToolbarStuck(false);
      return;
    }
    const io = new IntersectionObserver(([entry]) => setToolbarStuck(!entry!.isIntersecting), { root: main, threshold: 0 });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [routeKey, isRoot, isEmptyLibrary]);

  // ———————————————————— 布局 ————————————————————
  const packLayout = useMemo<GalleryLayout>(() => {
    const count = packItems.length;
    if (prefs.packView === 'list' && isRoot) return listLayout(count, contentWidth, PACK_LIST_ROW_H);
    return gridLayout({
      count,
      width: contentWidth,
      minCard: prefs.coverSize,
      gap: PACK_GAP,
      mediaAspect: 5 / 4,
      captionH: PACK_STACK_H + PACK_CAPTION_H,
    });
  }, [contentWidth, isRoot, packItems.length, prefs.coverSize, prefs.packView]);

  const imageGap = gridGap(prefs.thumbSize);
  const imageLayout = useMemo<GalleryLayout>(() => {
    const count = galleryImages.length;
    const captionH = prefs.showNames && prefs.layout !== 'list' ? IMAGE_CAPTION_H : 0;
    if (prefs.layout === 'list') return listLayout(count, contentWidth, IMAGE_LIST_ROW_H);
    if (prefs.layout === 'justified') {
      const aspects = new Float64Array(count);
      galleryImages.forEach((image, i) => {
        aspects[i] = image.width && image.height ? image.width / image.height : NaN;
      });
      return justifiedLayout({ aspects, width: contentWidth, targetHeight: prefs.thumbSize, gap: imageGap, captionH });
    }
    return gridLayout({ count, width: contentWidth, minCard: prefs.thumbSize, gap: imageGap, mediaAspect: 1, captionH });
  }, [contentWidth, galleryImages, imageGap, prefs.layout, prefs.showNames, prefs.thumbSize]);

  const imageKeys = useMemo(() => galleryImages.map((image) => image.id), [galleryImages]);
  const packKeys = useMemo(() => packItems.map((item) => folderKey(item.folder.id)), [packItems]);
  /** 键盘导航 / 全选作用的主表面：图包页 = 图片，首页 = 图包。 */
  const primary = useMemo(
    () => (isRoot
      ? { keys: packKeys, layout: packLayout, surfaceRef: packSurfaceRef }
      : { keys: imageKeys, layout: imageLayout, surfaceRef: imageSurfaceRef }),
    [imageKeys, imageLayout, isRoot, packKeys, packLayout],
  );

  // ———————————————————— 预取 ————————————————————
  const directionalTokenRef = useRef<{ cancelled: boolean } | null>(null);
  const onImageWindowChange = useCallback((win: SurfaceWindow) => {
    if (!win.direction || !isPrefetchEnabled()) return;
    const layout = imageLayout;
    const rows = win.screenRows;
    const r0 = win.direction === 'down' ? win.rows.last : Math.max(0, win.rows.first - rows);
    const r1 = win.direction === 'down' ? Math.min(layout.rowCount, win.rows.last + rows) : win.rows.first;
    if (r1 <= r0) return;
    const c0 = layout.rowRange(r0)[0];
    const c1 = layout.rowRange(r1 - 1)[1];
    if (directionalTokenRef.current) directionalTokenRef.current.cancelled = true;
    const token = { cancelled: false };
    directionalTokenRef.current = token;
    const targets: FileRef[] = galleryImages.slice(c0, c1).map(imageFileRef);
    preloadThumbnails(store, targets, { priority: THUMB_PRIORITY_DIRECTIONAL, recheck: true, shouldStop: () => token.cancelled });
    logDebug('prefetch', `滚动方向预取：${targets.length} 张（${c0}–${c1}，${win.direction}）`);
  }, [galleryImages, imageLayout, store]);

  // 当前图包（优先级 2）：切换图包时把同键的全库预热从优先级 4 提升。
  useEffect(() => {
    if (!isPrefetchEnabled() || galleryImages.length === 0) return;
    const token = { cancelled: false };
    preloadThumbnails(store, galleryImages.map(imageFileRef), {
      concurrency: 2,
      priority: THUMB_PRIORITY_CURRENT_DIR,
      recheck: true,
      shouldStop: () => token.cancelled,
    });
    logDebug('prefetch', `当前图包预取：${galleryImages.length} 张`);
    return () => {
      token.cancelled = true;
    };
  }, [galleryImages, store]);

  // 子图包 / 首页图包封面与前若干张（优先级 3），空闲时后台预热。
  useEffect(() => {
    if (!snapshot || !isPrefetchEnabled()) return;
    const folders = isRoot ? topFolders : childrenOf(snapshot, currentFolderId);
    if (folders.length === 0) return;
    const token = { cancelled: false };
    const targets: FileRef[] = [];
    const covers: FileRef[] = [];
    for (const folder of folders.slice(0, PRELOAD_MAX_FOLDERS)) {
      const cover = coverFor(folder.id);
      if (cover) (pinnedCovers[folder.id] === cover.id ? covers : targets).push(imageFileRef(cover));
      for (const image of directImagesOf(snapshot, folder.id).slice(0, PRELOAD_PER_FOLDER)) targets.push(imageFileRef(image));
    }
    const schedule = (work: () => void) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(work, { timeout: 1500 });
      else window.setTimeout(work, 0);
    };
    if (targets.length) schedule(() => preloadThumbnails(store, targets, { priority: THUMB_PRIORITY_SUBFOLDER, shouldStop: () => token.cancelled }));
    if (covers.length) schedule(() => preloadThumbnails(store, covers, { maxSize: COVER_THUMBNAIL_SIZE, priority: THUMB_PRIORITY_SUBFOLDER, shouldStop: () => token.cancelled }));
    logDebug('prefetch', `子图包预取：${targets.length} 张`);
    return () => {
      token.cancelled = true;
    };
  }, [coverFor, currentFolderId, isRoot, pinnedCovers, snapshot, store, topFolders]);

  // 全库缩略图在空闲后以最低优先级生成；滚动时调度器暂停这一级。
  useEffect(() => {
    if (!snapshot || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const targets = Object.values(snapshot.images).map(imageFileRef);
    if (targets.length === 0) return;
    const start = () => {
      preloadThumbnails(store, targets, { concurrency: 2, priority: THUMB_PRIORITY_WARMUP, shouldStop: () => token.cancelled });
      logDebug('prefetch', `全库空闲预热：${targets.length} 张`);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 2000 });
    else window.setTimeout(start, 250);
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, store]);

  // 窗口重新获得焦点时重扫（导入 / 整理进行中跳过；1 秒内只扫一次）。
  const autoRefreshAtRef = useRef(0);
  useEffect(() => {
    if (busy || runningTask) return;
    const run = () => {
      const now = Date.now();
      if (document.visibilityState !== 'visible' || now - autoRefreshAtRef.current < 1000) return;
      autoRefreshAtRef.current = now;
      void refresh();
    };
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', run);
    return () => {
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', run);
    };
  }, [busy, refresh, runningTask]);

  // ———————————————————— 选择 ————————————————————
  const keysForKey = useCallback((key: string) => (isFolderKey(key) ? packKeys : imageKeys), [imageKeys, packKeys]);

  const toggleSelect = useCallback((key: string, range: boolean) => {
    const keys = keysForKey(key);
    const anchor = anchorRef.current;
    setSelection((current) => {
      const next = new Set(current);
      if (range && anchor && keys.includes(anchor) && keys.includes(key)) {
        const a = keys.indexOf(anchor);
        const b = keys.indexOf(key);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(keys[i]!);
        return next;
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!range || !anchor) anchorRef.current = key;
    setFocusKey(key);
  }, [keysForKey]);

  const selectAll = useCallback(() => setSelection(new Set(primary.keys)), [primary.keys]);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    anchorRef.current = null;
  }, []);

  // ———————————————————— 查看器 ————————————————————
  const openViewer = useCallback((image: ImageEntry, list?: ImageEntry[]) => {
    setViewerList(list ?? null);
    setViewerImageId(image.id);
    setContextMenu(null);
  }, []);
  const viewerImages = viewerList ?? galleryImages;
  const viewerIndex = viewerImageId ? viewerImages.findIndex((image) => image.id === viewerImageId) : -1;
  useEffect(() => {
    if (viewerImageId && viewerIndex < 0) {
      setViewerImageId(null);
      setViewerList(null);
    }
  }, [viewerImageId, viewerIndex]);

  const closeViewer = useCallback(() => {
    if (viewerImageId) setFocusKey(viewerImageId);
    setViewerImageId(null);
    setViewerList(null);
  }, [viewerImageId]);

  // 记录继续浏览位置（按图片 id，本机）。
  useEffect(() => {
    if (!viewerImageId || !snapshot) return;
    const folderId = browseFolderFor(snapshot, currentFolderId, viewerImageId);
    if (!folderId) return;
    setRecentBrowse((prev) => {
      const next = recordRecentBrowse(prev, folderId, viewerImageId);
      saveRecentBrowse(next);
      return next;
    });
  }, [currentFolderId, snapshot, viewerImageId]);

  // 查看器闲置：鼠标静止一段时间后工具栏与胶片条淡出。
  useEffect(() => {
    if (!viewerImageId) {
      setViewerIdle(false);
      return;
    }
    let timer = window.setTimeout(() => setViewerIdle(true), VIEWER_IDLE_MS);
    const wake = () => {
      setViewerIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setViewerIdle(true), VIEWER_IDLE_MS);
    };
    window.addEventListener('mousemove', wake);
    window.addEventListener('mousedown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('mousedown', wake);
    };
  }, [viewerImageId]);

  useEffect(() => {
    try {
      localStorage.setItem('kanitsu-filmstrip', filmstripVisible ? '1' : '0');
    } catch {
      // Ignore storage errors.
    }
  }, [filmstripVisible]);

  // 同级图包切换（查看器 ↑/↓）：跳过没有图片的图包。
  const handleViewerSwitchSibling = useCallback((dir: number) => {
    if (!snapshot || isRoot) return;
    const parentId = snapshot.folders[currentFolderId]?.parentId ?? snapshot.rootId;
    const siblings = childrenOf(snapshot, parentId).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    const start = siblings.findIndex((f) => f.id === currentFolderId);
    for (let step = 1; step < siblings.length; step++) {
      const next = siblings[(((start + dir * step) % siblings.length) + siblings.length) % siblings.length]!;
      const images = prefs.includeSubfolders ? imagesOf(snapshot, next.id) : directImagesOf(snapshot, next.id);
      if (images.length === 0) continue;
      selectFolder(next.id);
      setViewerList(null);
      setViewerImageId(sortImages(images, prefs.sort, prefs.sortDir)[0]!.id);
      return;
    }
    notify('没有其他含图片的同级图包', 'info');
  }, [currentFolderId, isRoot, notify, prefs.includeSubfolders, prefs.sort, prefs.sortDir, selectFolder, snapshot]);

  // ———————————————————— 标记：封面 / 隐私 ————————————————————
  const pinCover = useCallback((folderId: string, imageId: string | null, imageName?: string) => {
    setPinnedCovers((prev) => {
      const next = { ...prev };
      if (imageId) next[folderId] = imageId;
      else delete next[folderId];
      savePinnedCovers(next);
      return next;
    });
    notify(imageId ? `已将「${imageName ?? '该图片'}」设为图包封面` : '已恢复智能封面', 'success');
  }, [notify]);

  const toggleImagePin = useCallback((image: ImageEntry) => {
    const pinned = pinnedCovers[image.folderId] === image.id;
    pinCover(image.folderId, pinned ? null : image.id, image.name);
  }, [pinCover, pinnedCovers]);

  const setBlurred = useCallback((relPaths: Iterable<string>, blurred: boolean) => {
    setBlurredImages((prev) => {
      const next = new Set(prev);
      for (const p of relPaths) {
        if (blurred) next.add(p);
        else next.delete(p);
      }
      saveBlurredImages(next);
      return next;
    });
  }, []);

  const toggleImageBlur = useCallback((image: ImageEntry) => {
    setBlurred([image.relPath], !blurredImages.has(image.relPath));
  }, [blurredImages, setBlurred]);

  const toggleFolderBlur = useCallback((folder: FolderNode) => {
    if (!snapshot) return;
    const images = imagesOf(snapshot, folder.id);
    if (images.length === 0) return;
    const all = images.every((image) => blurredImages.has(image.relPath));
    setBlurred(images.map((image) => image.relPath), !all);
    notify(all ? `已取消「${folder.name}」的隐私预览` : `已为「${folder.name}」的 ${formatCount(images.length)} 张图片开启隐私预览`, 'success');
  }, [blurredImages, notify, setBlurred, snapshot]);

  const toggleSelectionBlur = useCallback(() => {
    if (selectionBlurTargets.size === 0) return;
    setBlurred(selectionBlurTargets, !selectionAllBlurred);
    notify(selectionAllBlurred ? '已取消所选项目的隐私预览' : '已为所选项目开启隐私预览', 'success');
  }, [notify, selectionAllBlurred, selectionBlurTargets, setBlurred]);

  const copyPath = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`已复制库内路径：${text || '/'}`, 'success');
    } catch {
      notify(`无法复制，请手动复制：${text}`, 'error');
    }
  }, [notify]);

  // ———————————————————— 导入 ————————————————————
  const runImport = useCallback(async (source?: FolderRef) => {
    if (importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    const token = `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const taskId = startTask({ kind: 'import', title: '导入图包', detail: '正在读取文件夹…', cancelable: !!store.cancelTask });
    if (store.cancelTask) taskCancelRef.current.set(taskId, () => void store.cancelTask?.(token));
    // 选好源文件夹后（第一次进度回调）才提示开始导入；在系统选择框里取消不提示。
    let announced = false;
    try {
      const task = await importFolder(picker, store, {
        source,
        cancelToken: token,
        onProgress: (p) => {
          if (!announced) {
            announced = true;
            const name = p.current || source?.name;
            notify(`开始导入${name ? `「${name}」` : ''}— 可在任务中心查看进度`, 'info', [
              { label: '任务中心', onPress: () => setTaskPopoverOpen(true) },
            ]);
          }
          patchTask(taskId, { done: p.copied, detail: `已扫描 ${formatCount(p.scanned)} · 已复制 ${formatCount(p.copied)} · 跳过 ${formatCount(p.skipped)}` });
        },
      });
      const title = `导入「${task.targetTopFolder || task.sourceFolderName}」`;
      const next = await refresh();
      const top = Object.values(next.folders).find((f) => f.parentId === next.rootId && f.name === task.targetTopFolder);
      if (top) {
        setImportedAt((prev) => {
          const map = { ...prev, [top.id]: Date.now() };
          saveImportedAt(map);
          return map;
        });
        setFreshFolders((prev) => new Set(prev).add(top.id));
      }
      const skipped = task.skippedCount > 0 ? ` · 跳过 ${formatCount(task.skippedCount)} 个` : '';
      const failed = task.errors.length > 0 ? ` · 失败 ${task.errors.length} 个` : '';
      const openAction = top ? [{ label: '打开', onPress: () => selectFolder(top.id) }] : [];
      if (task.status === 'canceled') {
        finishTask(taskId, 'canceled', { title, report: task, result: `已取消 · 已复制 ${formatCount(task.copiedImageCount)} 张`, openFolderId: top?.id });
        notify(`导入已取消：已复制 ${formatCount(task.copiedImageCount)} 张`, 'info', openAction);
        return;
      }
      finishTask(taskId, 'done', {
        title,
        report: task,
        result: `复制 ${formatCount(task.copiedImageCount)} 张${skipped}${failed}`,
        openFolderId: top?.id,
        total: task.copiedImageCount,
        done: task.copiedImageCount,
      });
      const reportAction = task.skippedCount + task.errors.length > 0
        ? [{
            label: '查看明细',
            onPress: () => {
              setTaskReportOpen((prev) => new Set(prev).add(taskId));
              setTaskPopoverOpen(true);
              setTasksUnseen(false);
            },
          }]
        : [];
      notify(`已导入「${task.targetTopFolder}」· ${formatCount(task.copiedImageCount)} 张${skipped}`, 'success', [...reportAction, ...openAction]);
    } catch (err) {
      const msg = String(err);
      if (/取消/.test(msg)) dropTask(taskId);
      else {
        finishTask(taskId, 'failed', { result: `失败：${msg}` });
        notify(`导入失败：${msg}`, 'error');
      }
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [dropTask, finishTask, notify, patchTask, picker, refresh, selectFolder, startTask, store]);

  // 拖入导入（仅平台支持时）：拖入文件夹 → 主进程原生确认 → 逐个导入。
  const canDrop = typeof picker.resolveDroppedFolder === 'function';
  useEffect(() => {
    if (!canDrop) return;
    let depth = 0;
    // Chromium 拖动页面内的 <img> 时 types 里也带 Files：应用内发起的拖动一律不当作导入。
    let internal = false;
    const onDragStart = () => {
      internal = true;
    };
    const onDragEnd = () => {
      internal = false;
    };
    const hasFiles = (event: DragEvent) => !internal && !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragCount(Math.max(1, [...(event.dataTransfer?.items ?? [])].filter((item) => item.kind === 'file').length));
    };
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragCount(0);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragCount(0);
      const files = [...(event.dataTransfer?.files ?? [])];
      // 导入进行中不再确认新的拖入：主进程确认即改写授权的导入源，会打断正在进行的导入。
      if (importingRef.current) {
        notify('正在导入，请等当前导入完成后再拖入', 'info');
        return;
      }
      void (async () => {
        for (const file of files) {
          if (importingRef.current) break; // 期间用户又手动开始了导入
          try {
            const source = await picker.resolveDroppedFolder!(file);
            await runImport(source);
          } catch (err) {
            // IPC 错误形如 “Error invoking remote method 'x': Error: <msg>”，只保留说明文字。
            const msg = String(err).replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '');
            if (!/取消/.test(msg)) notify(msg, 'error');
          }
        }
      })();
    };
    window.addEventListener('dragstart', onDragStart);
    window.addEventListener('dragend', onDragEnd);
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragstart', onDragStart);
      window.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [canDrop, notify, picker, runImport]);

  // ———————————————————— 导出 ————————————————————
  const runExport = useCallback(async (
    title: string,
    run: (onProgress: (done: number, total: number) => void) => Promise<{ canceled?: boolean; exportedCount: number; totalImages: number; outputPath?: string; blob?: Blob }>,
    fileBase: string,
  ) => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    const taskId = startTask({ kind: 'export', title, detail: '选择保存位置…' });
    try {
      const result = await run((done, total) => patchTask(taskId, { done, total, detail: undefined }));
      if (result.canceled) {
        finishTask(taskId, 'canceled', { result: `已取消 · 已写入 ${formatCount(result.exportedCount)} 张` });
        return;
      }
      if (result.blob) downloadBlob(result.blob, `${fileBase}.zip`);
      const where = result.outputPath ? ` · ${result.outputPath}` : '';
      finishTask(taskId, 'done', { done: result.exportedCount, total: result.totalImages, result: `已导出 ${formatCount(result.exportedCount)} 张${where}`, outputPath: result.outputPath });
      notify(`已导出 ${formatCount(result.exportedCount)} 张图片${result.outputPath ? `到 ${result.outputPath}` : ''}`, 'success');
    } catch (err) {
      const msg = String(err);
      if (/取消/.test(msg)) dropTask(taskId);
      else {
        finishTask(taskId, 'failed', { result: `失败：${msg}` });
        notify(`导出失败：${msg}`, 'error');
      }
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }, [dropTask, finishTask, notify, patchTask, startTask]);

  const exportFolder = useCallback((folder: FolderNode) => {
    const base = folder.relPath ? folder.name : '全部图包';
    void runExport(`导出「${base}」为 ZIP`, (onProgress) => store.zipLibrary(folder.relPath, onProgress), base);
  }, [runExport, store]);

  const exportSelection = useCallback(() => {
    if (!store.zipSelection || !snapshot) return;
    const relPaths = new Set(selectedImages.map((image) => image.relPath));
    for (const folder of selectedFolders) for (const image of imagesOf(snapshot, folder.id)) relPaths.add(image.relPath);
    const base = selectedFolder?.relPath ? `${selectedFolder.name}-所选` : 'Kanitsu-所选';
    void runExport(`导出所选 ${formatCount(relPaths.size)} 张为 ZIP`, (onProgress) => store.zipSelection!([...relPaths], base, onProgress), base);
  }, [runExport, selectedFolder, selectedFolders, selectedImages, snapshot, store]);

  // ———————————————————— 整理 / 撤销 ————————————————————
  const handleUndo = useCallback(async (taskId?: string) => {
    const last = lastUndo;
    if (!last || (taskId && taskId !== last.taskId)) return;
    setBusy(true);
    try {
      const result = await undoOrganize(store, last.manifest);
      setLastUndo(null);
      setTasks((prev) => prev.map((t) => (t.id === last.taskId ? { ...t, undoable: false, result: `${t.result ?? ''} · 已撤销` } : t)));
      await refresh();
      notify(
        result.errors.length > 0 ? `撤销完成：已还原 ${result.undone} 项，${result.errors.length} 项失败` : `已撤销，还原 ${formatCount(result.undone)} 项`,
        result.errors.length ? 'error' : 'success',
      );
    } catch (err) {
      notify(`撤销失败：${String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [lastUndo, notify, refresh, store]);
  const undoRef = useRef(handleUndo);
  undoRef.current = handleUndo;

  /** 新的可撤销操作完成：旧任务的撤销入口失效，只保留最近一次。 */
  const replaceUndo = useCallback((entry: UndoEntry | null) => {
    setTasks((prev) => prev.map((t) => (t.undoable && t.id !== entry?.taskId ? { ...t, undoable: false } : t)));
    setLastUndo(entry);
  }, []);

  const applyOrganizePlan = useCallback(async (folder: FolderNode, bindings: OrganizeBinding[], ruleName: string) => {
    const snap = snapshotRef.current;
    if (!snap) return;
    setDialog(null);
    setBusy(true);
    const flag = { cancelled: false };
    const taskId = startTask({ kind: 'organize', title: `整理「${folder.name}」`, total: bindings.length, cancelable: true });
    taskCancelRef.current.set(taskId, () => {
      flag.cancelled = true;
    });
    try {
      const result = await applyOrganize(store, snap, folder.relPath, bindings, {
        onProgress: (done, total) => patchTask(taskId, { done, total }),
        shouldCancel: () => flag.cancelled,
      });
      const dirs = new Set(bindings.map((b) => b.virtualPath.split('/').slice(0, -1).join('/'))).size;
      const summary = `按「${ruleName}」移动 ${formatCount(result.appliedCount)} 张 · ${dirs} 个目录${result.conflicts.length ? ` · ${result.conflicts.length} 个冲突` : ''}`;
      const undoable = result.appliedCount > 0;
      finishTask(taskId, result.canceled ? 'canceled' : 'done', {
        result: result.canceled ? `已取消 · ${summary}` : summary,
        conflicts: result.conflicts,
        undoable,
        openFolderId: folder.id,
      });
      replaceUndo(undoable ? { taskId, kind: 'organize', manifest: result.manifest } : null);
      await refresh();
      notify(
        result.canceled
          ? `整理已取消：已移动 ${formatCount(result.appliedCount)} 张`
          : `已整理 ${formatCount(result.appliedCount)} 张${result.conflicts.length ? `，${result.conflicts.length} 个冲突` : ''}`,
        'success',
        undoable ? [{ label: '撤销', onPress: () => void undoRef.current(taskId) }] : undefined,
      );
    } catch (err) {
      finishTask(taskId, 'failed', { result: `失败：${String(err)}` });
      notify(`整理失败：${String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [finishTask, notify, patchTask, refresh, replaceUndo, startTask, store]);

  // ———————————————————— 新建 / 重命名 / 删除 / 移动 / 合并 ————————————————————
  const siblingNames = useCallback((parentId: string | null, exceptId?: string) => {
    const snap = snapshotRef.current;
    if (!snap || !parentId) return [];
    return childrenOf(snap, parentId).filter((f) => f.id !== exceptId).map((f) => f.name);
  }, []);

  const createFolderIn = useCallback((parent: FolderNode, onCreated?: (folder: FolderNode) => void) => {
    const taken = siblingNames(parent.id);
    let initial = '新建图包';
    for (let i = 2; taken.includes(initial); i++) initial = `新建图包 (${i})`;
    setContextMenu(null);
    setDialog({
      kind: 'prompt',
      options: {
        title: parent.relPath ? `在「${parent.name}」中新建子图包` : '新建图包',
        initialValue: initial,
        confirmLabel: '新建',
        validate: (value) => validateEntryName(value, siblingNames(parent.id)),
        onSubmit: (name) => {
          void (async () => {
            setBusy(true);
            try {
              const rel = joinRelPath(parent.relPath, name);
              await createSubfolder(store, parent.relPath, name);
              const next = await refresh();
              const created = Object.values(next.folders).find((f) => f.relPath === rel);
              if (created) {
                setExpandedFolders((prev) => new Set(prev).add(parent.id));
                if (onCreated) onCreated(created);
                else notify(`已新建「${name}」`, 'success', [{ label: '打开', onPress: () => selectFolder(created.id) }]);
              }
            } catch (err) {
              notify(`新建失败：${String(err)}`, 'error');
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    });
  }, [notify, refresh, selectFolder, siblingNames, store]);

  const renameImageAction = useCallback((image: ImageEntry) => {
    const snap = snapshotRef.current;
    const siblings = snap ? directImagesOf(snap, image.folderId).filter((i) => i.id !== image.id).map((i) => i.name) : [];
    setContextMenu(null);
    setDialog({
      kind: 'prompt',
      options: {
        title: '重命名图片',
        initialValue: image.name,
        confirmLabel: '重命名',
        selectStem: true,
        hint: '省略扩展名时会保留原扩展名。',
        validate: (value) => validateEntryName(value, siblings, image.name),
        onSubmit: (name) => {
          if (name === image.name) return;
          void (async () => {
            setBusy(true);
            try {
              const renamed = await renameImage(store, image, name);
              await refresh();
              notify(`已重命名为「${renamed.name}」`, 'success');
            } catch (err) {
              notify(`重命名失败：${String(err)}`, 'error');
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    });
  }, [notify, refresh, store]);

  const renameFolderAction = useCallback((folder: FolderNode) => {
    if (!folder.relPath) return;
    setContextMenu(null);
    setDialog({
      kind: 'prompt',
      options: {
        title: '重命名图包',
        initialValue: folder.name,
        confirmLabel: '重命名',
        validate: (value) => validateEntryName(value, siblingNames(folder.parentId, folder.id), folder.name),
        onSubmit: (name) => {
          if (name === folder.name) return;
          void (async () => {
            setBusy(true);
            try {
              await renameFolder(store, folder, name);
              await refresh();
              notify(`已重命名为「${name}」`, 'success');
            } catch (err) {
              notify(`重命名失败：${String(err)}`, 'error');
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    });
  }, [notify, refresh, siblingNames, store]);

  const renameKey = useCallback((key: string) => {
    const snap = snapshotRef.current;
    if (!snap) return;
    if (isFolderKey(key)) {
      const folder = snap.folders[key.slice(2)];
      if (folder) renameFolderAction(folder);
    } else {
      const image = snap.images[key];
      if (image) renameImageAction(image);
    }
  }, [renameFolderAction, renameImageAction]);

  const requestDelete = useCallback((images: ImageEntry[], folders: FolderNode[]) => {
    const deletable = folders.filter((f) => f.relPath);
    if (images.length + deletable.length === 0) return;
    setContextMenu(null);
    setDialog({ kind: 'delete', request: { images, folders: deletable } });
  }, []);

  const confirmDelete = useCallback(async (request: DeleteRequest) => {
    setDialog(null);
    // 查看器里删掉当前图：删完停在相邻的一张，而不是直接退出查看器。
    const deletingIds = new Set(request.images.map((image) => image.id));
    const viewerNext = viewerImageId && deletingIds.has(viewerImageId)
      ? (() => {
          const i = viewerImages.findIndex((image) => image.id === viewerImageId);
          const rest = viewerImages.filter((image) => !deletingIds.has(image.id));
          if (rest.length === 0) return null;
          const after = viewerImages.slice(i + 1).find((image) => !deletingIds.has(image.id));
          return after ?? rest[rest.length - 1]!;
        })()
      : undefined;
    const total = request.images.length + request.folders.length;
    const taskId = total > 1 ? startTask({ kind: 'delete', title: `删除 ${formatCount(total)} 项`, total }) : null;
    setBusy(true);
    let ok = 0;
    let failed = 0;
    try {
      for (const image of request.images) {
        try {
          await deleteImage(store, image);
          ok++;
        } catch {
          failed++;
        }
        if (taskId) patchTask(taskId, { done: ok + failed });
      }
      for (const folder of request.folders) {
        try {
          await deleteLibraryFolder(store, folder.relPath);
          ok++;
        } catch {
          failed++;
        }
        if (taskId) patchTask(taskId, { done: ok + failed });
      }
      if (viewerNext !== undefined) {
        if (viewerNext) {
          setViewerList((list) => (list ? list.filter((image) => !deletingIds.has(image.id)) : list));
          setViewerImageId(viewerNext.id);
        } else {
          setViewerImageId(null);
          setViewerList(null);
        }
      }
      const next = await refresh();
      if (!next.folders[currentFolderId]) {
        const parent = request.folders.find((f) => f.id === currentFolderId)?.parentId;
        selectFolder(parent && next.folders[parent] ? parent : next.rootId);
      }
      clearSelection();
      const text = failed > 0
        ? `已删除 ${formatCount(ok)} 项，失败 ${failed} 项`
        : total === 1
          ? `已删除「${request.images[0]?.name ?? request.folders[0]?.name}」`
          : `已删除 ${formatCount(ok)} 项`;
      if (taskId) finishTask(taskId, failed ? 'failed' : 'done', { result: text });
      notify(text, failed ? 'error' : 'success');
    } catch (err) {
      if (taskId) finishTask(taskId, 'failed', { result: String(err) });
      notify(`删除失败：${String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [clearSelection, currentFolderId, finishTask, notify, patchTask, refresh, selectFolder, startTask, store, viewerImageId, viewerImages]);

  const requestMove = useCallback((imageIds: string[], folderIds: string[]) => {
    if (imageIds.length + folderIds.length === 0) return;
    setContextMenu(null);
    setDialog({ kind: 'move', imageIds, folderIds });
  }, []);

  const confirmMove = useCallback(async (imageIds: string[], folderIds: string[], target: FolderNode) => {
    const snap = snapshotRef.current;
    if (!snap) return;
    setDialog(null);
    setBusy(true);
    const total = imageIds.length + folderIds.length;
    const targetName = target.relPath ? target.name : '图库根目录';
    const taskId = startTask({ kind: 'move', title: `移动 ${formatCount(total)} 项到「${targetName}」`, total });
    try {
      const result = await moveEntries(store, snap, target.relPath, { imageIds, folderIds }, {
        onProgress: (done, t) => patchTask(taskId, { done, total: t }),
      });
      const moved = result.movedImages + result.movedFolders;
      // 图包整体移动不进撤销清单：只有纯图片移动才提供撤销。
      const undoable = result.manifest.actions.length > 0 && result.movedFolders === 0;
      const failText = result.failures.length ? ` · ${result.failures.length} 项未移动` : '';
      finishTask(taskId, 'done', { result: `已移动 ${formatCount(moved)} 项${failText}`, undoable, openFolderId: target.id });
      replaceUndo(undoable ? { taskId, kind: 'move', manifest: result.manifest } : null);
      await refresh();
      clearSelection();
      const reasons = [...new Set(result.failures.map((f) => (f.reason === 'invalid-target' ? '不能移入自身内部' : f.reason === 'target-exists' ? '目标已有同名图包' : '移动失败')))];
      notify(
        `已移动 ${formatCount(moved)} 项到「${targetName}」${result.failures.length ? `，${result.failures.length} 项未移动（${reasons.join('、')}）` : ''}`,
        result.failures.length && moved === 0 ? 'error' : 'success',
        [
          ...(undoable ? [{ label: '撤销', onPress: () => void undoRef.current(taskId) }] : []),
          { label: '打开', onPress: () => selectFolder(target.id) },
        ],
      );
    } catch (err) {
      finishTask(taskId, 'failed', { result: `失败：${String(err)}` });
      notify(`移动失败：${String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [clearSelection, finishTask, notify, patchTask, refresh, replaceUndo, selectFolder, startTask, store]);

  const requestMerge = useCallback((imageIds: string[], folderIds: string[]) => {
    const snap = snapshotRef.current;
    const container = selectedFolder;
    if (!snap || !container || imageIds.length + folderIds.length < 1) return;
    setContextMenu(null);
    const taken = siblingNames(container.id);
    let initial = '合并图包';
    for (let i = 2; taken.includes(initial); i++) initial = `合并图包 (${i})`;
    const count = imageIds.length + folderIds.length;
    setDialog({
      kind: 'prompt',
      options: {
        title: count > 1 ? `把 ${formatCount(count)} 项合并为新图包` : '放进新图包',
        description: `将在「${container.relPath ? container.name : '图库'}」中新建图包，所选图片与图包（含全部子图包）里的图片都会移入；被清空的图包会被删除。可以撤销。`,
        initialValue: initial,
        confirmLabel: '新建并移入',
        validate: (value) => validateEntryName(value, siblingNames(container.id)),
        onSubmit: (name) => {
          void (async () => {
            setBusy(true);
            const taskId = startTask({ kind: 'move', title: `合并为「${name}」` });
            try {
              const result = await mergeIntoNewPack(store, snap, container.relPath, name, { imageIds, folderIds }, {
                onProgress: (done, total) => patchTask(taskId, { done, total }),
              });
              const undoable = result.manifest.actions.length > 0;
              const notes: string[] = [];
              if (result.conflicts.length) notes.push(`${result.conflicts.length} 张移动失败`);
              if (result.keptFolderRels.length) notes.push(`${result.keptFolderRels.length} 个图包仍有图片而保留`);
              const next = await refresh();
              const created = Object.values(next.folders).find((f) => f.relPath === result.createdRelPath);
              finishTask(taskId, 'done', {
                result: `已合并 ${formatCount(result.movedCount)} 张${notes.length ? ` · ${notes.join(' · ')}` : ''}`,
                undoable,
                openFolderId: created?.id,
                conflicts: result.conflicts,
              });
              replaceUndo(undoable ? { taskId, kind: 'merge', manifest: result.manifest } : null);
              clearSelection();
              notify(`已合并 ${formatCount(result.movedCount)} 张到「${name}」${notes.length ? `，${notes.join('；')}` : ''}`, 'success', [
                ...(undoable ? [{ label: '撤销', onPress: () => void undoRef.current(taskId) }] : []),
                ...(created ? [{ label: '打开', onPress: () => selectFolder(created.id) }] : []),
              ]);
            } catch (err) {
              finishTask(taskId, 'failed', { result: `失败：${String(err)}` });
              notify(`合并失败：${String(err)}`, 'error');
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    });
  }, [clearSelection, finishTask, notify, patchTask, refresh, replaceUndo, selectFolder, selectedFolder, siblingNames, startTask, store]);

  // ———————————————————— 右键菜单 ————————————————————
  const openMenuAt = useCallback((x: number, y: number, items: ContextMenuItem[]) => setContextMenu({ x, y, items }), []);
  const openMenu = useCallback((event: ReactMouseEvent, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    openMenuAt(event.clientX, event.clientY, items);
  }, [openMenuAt]);
  const openMenuBelow = useCallback((anchor: HTMLElement, items: ContextMenuItem[]) => {
    const rect = anchor.getBoundingClientRect();
    openMenuAt(rect.left, rect.bottom + 4, items);
  }, [openMenuAt]);

  const batchMenu = useCallback((): ContextMenuItem[] => {
    const imageIds = selectedImages.map((i) => i.id);
    const folderIds = selectedFolders.map((f) => f.id);
    return [
      { label: `移动 ${formatCount(selectionCount)} 项到…`, icon: <ArrowsLeftRight size={16} />, onSelect: () => requestMove(imageIds, folderIds) },
      { label: '合并为新图包…', icon: <Stack size={16} />, onSelect: () => requestMerge(imageIds, folderIds) },
      { label: selectionAllBlurred ? '取消隐私预览' : '隐私预览', icon: <EyeSlash size={16} />, onSelect: toggleSelectionBlur },
      ...(store.zipSelection ? [{ label: '导出所选为 ZIP…', icon: <FileZip size={16} />, onSelect: exportSelection }] : []),
      { label: `删除 ${formatCount(selectionCount)} 项…`, icon: <Trash size={16} />, danger: true, separator: true, onSelect: () => requestDelete(selectedImages, selectedFolders) },
    ];
  }, [exportSelection, requestDelete, requestMerge, requestMove, selectedFolders, selectedImages, selectionAllBlurred, selectionCount, store.zipSelection, toggleSelectionBlur]);

  const imageMenu = useCallback((image: ImageEntry): ContextMenuItem[] => {
    if (selection.has(image.id) && selectionCount > 1) return batchMenu();
    const blurred = blurredImages.has(image.relPath);
    const pinned = pinnedCovers[image.folderId] === image.id;
    return [
      ...(viewerImageId ? [] : [{ label: '在查看器中打开', icon: <Eye size={16} />, onSelect: () => openViewer(image) }]),
      { label: pinned ? '取消固定封面' : '设为图包封面', icon: <PushPin size={16} />, checked: pinned, separator: !viewerImageId, onSelect: () => toggleImagePin(image) },
      { label: '隐私预览', icon: <EyeSlash size={16} />, checked: blurred, onSelect: () => toggleImageBlur(image) },
      { label: '重命名…', icon: <PencilSimple size={16} />, separator: true, onSelect: () => renameImageAction(image) },
      { label: '移动到…', icon: <ArrowsLeftRight size={16} />, onSelect: () => requestMove([image.id], []) },
      { label: '放进新图包…', icon: <Stack size={16} />, disabled: isRoot, onSelect: () => requestMerge([image.id], []) },
      { label: '复制库内路径', icon: <Copy size={16} />, onSelect: () => void copyPath(image.relPath) },
      { label: '删除…', icon: <Trash size={16} />, danger: true, separator: true, onSelect: () => requestDelete([image], []) },
    ];
  }, [batchMenu, blurredImages, copyPath, isRoot, openViewer, pinnedCovers, renameImageAction, requestDelete, requestMerge, requestMove, selection, selectionCount, toggleImageBlur, toggleImagePin, viewerImageId]);

  const folderMenu = useCallback((folder: FolderNode): ContextMenuItem[] => {
    if (selection.has(folderKey(folder.id)) && selectionCount > 1) return batchMenu();
    const snap = snapshotRef.current;
    const images = snap ? imagesOf(snap, folder.id) : [];
    const allBlurred = images.length > 0 && images.every((image) => blurredImages.has(image.relPath));
    const isLibRoot = !folder.relPath;
    const items: ContextMenuItem[] = [
      { label: '打开', icon: <FolderOpen size={16} />, onSelect: () => (isLibRoot ? goRoot('all') : openFolder(folder)) },
      { label: isLibRoot ? '新建图包…' : '新建子图包…', icon: <FolderPlus size={16} />, onSelect: () => createFolderIn(folder) },
    ];
    if (folder.relPath && folder.childCount > 0) {
      items.push({
        label: expandedFolders.has(folder.id) ? '在侧栏中收起' : '在侧栏中展开',
        icon: expandedFolders.has(folder.id) ? <CaretDown size={16} /> : <CaretRight size={16} />,
        onSelect: () => toggleFolderExpanded(folder.id),
      });
    }
    if (!isLibRoot) {
      items.push(
        { label: '设置封面…', icon: <ImageSquare size={16} />, separator: true, disabled: images.length === 0, onSelect: () => setDialog({ kind: 'cover', folderId: folder.id }) },
        { label: '智能整理…', icon: <MagicWand size={16} />, disabled: images.length === 0, onSelect: () => setDialog({ kind: 'organize', folderId: folder.id }) },
      );
    }
    items.push({ label: '隐私预览（含子图包）', icon: <EyeSlash size={16} />, checked: allBlurred, separator: isLibRoot, disabled: images.length === 0, onSelect: () => toggleFolderBlur(folder) });
    if (!isLibRoot) {
      items.push(
        { label: '重命名…', icon: <PencilSimple size={16} />, separator: true, onSelect: () => renameFolderAction(folder) },
        { label: '移动到…', icon: <ArrowsLeftRight size={16} />, onSelect: () => requestMove([], [folder.id]) },
      );
    }
    items.push(
      { label: '导出 ZIP…', icon: <FileZip size={16} />, separator: true, disabled: images.length === 0 || exporting, onSelect: () => exportFolder(folder) },
      { label: '复制库内路径', icon: <Copy size={16} />, onSelect: () => void copyPath(folder.relPath) },
    );
    if (!isLibRoot) items.push({ label: '删除…', icon: <Trash size={16} />, danger: true, separator: true, onSelect: () => requestDelete([], [folder]) });
    return items;
  }, [batchMenu, blurredImages, copyPath, createFolderIn, expandedFolders, exportFolder, exporting, goRoot, openFolder, renameFolderAction, requestDelete, requestMove, selection, selectionCount, toggleFolderBlur, toggleFolderExpanded]);

  const imageSortMenu = useCallback((anchor: HTMLElement) => {
    const sorts: [ImageSort, ReactNode][] = [
      ['name', <Tag size={16} />],
      ['modified', <ArrowClockwise size={16} />],
      ['size', <FileZip size={16} />],
      ['dims', <SquaresFour size={16} />],
    ];
    openMenuBelow(anchor, [
      ...sorts.map(([value, icon]) => ({ label: IMAGE_SORT_LABELS[value], icon, checked: prefs.sort === value, onSelect: () => setPref('sort', value) })),
      { label: '升序', checked: prefs.sortDir === 'asc', separator: true, onSelect: () => setPref('sortDir', 'asc') },
      { label: '降序', checked: prefs.sortDir === 'desc', onSelect: () => setPref('sortDir', 'desc') },
    ]);
  }, [openMenuBelow, prefs.sort, prefs.sortDir, setPref]);

  const packSortMenu = useCallback((anchor: HTMLElement) => {
    openMenuBelow(anchor, (Object.keys(PACK_SORT_LABELS) as PackSort[]).map((value) => ({
      label: PACK_SORT_LABELS[value],
      checked: prefs.packSort === value,
      onSelect: () => setPref('packSort', value),
    })));
  }, [openMenuBelow, prefs.packSort, setPref]);

  const selectAllRef = useRef(selectAll);
  selectAllRef.current = selectAll;
  const galleryBackgroundMenu = useCallback((event: ReactMouseEvent) => {
    if (!selectedFolder) return;
    openMenu(event, isRoot
      ? [
          { label: '全选', icon: <CheckSquare size={16} />, onSelect: () => selectAllRef.current() },
          { label: '新建图包…', icon: <FolderPlus size={16} />, onSelect: () => createFolderIn(selectedFolder) },
          { label: '封面视图', icon: <SquaresFour size={16} />, checked: prefs.packView === 'grid', separator: true, onSelect: () => setPref('packView', 'grid') },
          { label: '列表视图', icon: <List size={16} />, checked: prefs.packView === 'list', onSelect: () => setPref('packView', 'list') },
        ]
      : [
          { label: '全选', icon: <CheckSquare size={16} />, onSelect: () => selectAllRef.current() },
          { label: '新建子图包…', icon: <FolderPlus size={16} />, onSelect: () => createFolderIn(selectedFolder) },
          { label: '网格', icon: <SquaresFour size={16} />, checked: prefs.layout === 'grid', separator: true, onSelect: () => setPref('layout', 'grid') },
          { label: '按原比例', icon: <Rows size={16} />, checked: prefs.layout === 'justified', onSelect: () => setPref('layout', 'justified') },
          { label: '列表', icon: <List size={16} />, checked: prefs.layout === 'list', onSelect: () => setPref('layout', 'list') },
          { label: '显示文件名', icon: <Tag size={16} />, checked: prefs.showNames, separator: true, onSelect: () => setPref('showNames', !prefs.showNames) },
          { label: '包含子目录', icon: <Stack size={16} />, checked: prefs.includeSubfolders, onSelect: () => setPref('includeSubfolders', !prefs.includeSubfolders) },
        ]);
  }, [createFolderIn, isRoot, openMenu, prefs.includeSubfolders, prefs.layout, prefs.packView, prefs.showNames, selectedFolder, setPref]);

  // ———————————————————— 表面交互（点击 / 右键 / 框选） ————————————————————
  const activateKey = useCallback((key: string) => {
    const snap = snapshotRef.current;
    if (!snap) return;
    if (isFolderKey(key)) {
      const folder = snap.folders[key.slice(2)];
      if (folder) openFolder(folder);
    } else {
      const image = snap.images[key];
      if (image) openViewer(image);
    }
  }, [openFolder, openViewer]);

  const onSurfaceClick = useCallback((event: ReactMouseEvent) => {
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('[data-item]');
    if (!item) return;
    const key = item.dataset.item!;
    const snap = snapshotRef.current;
    const more = target.closest<HTMLElement>('[data-more]');
    if (more) {
      event.stopPropagation();
      const folder = isFolderKey(key) ? snap?.folders[key.slice(2)] : undefined;
      if (folder) openMenuBelow(more, folderMenu(folder));
      return;
    }
    if (target.closest('[data-check]') || event.ctrlKey || event.metaKey) {
      toggleSelect(key, event.shiftKey);
      return;
    }
    if (event.shiftKey) {
      toggleSelect(key, true);
      return;
    }
    // 已有选择时，单击改为增减选择（与 Android 端一致）。
    if (selection.size > 0) {
      toggleSelect(key, false);
      return;
    }
    setFocusKey(key);
    activateKey(key);
  }, [activateKey, folderMenu, openMenuBelow, selection.size, toggleSelect]);

  const onSurfaceContextMenu = useCallback((event: ReactMouseEvent) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-item]');
    const snap = snapshotRef.current;
    if (!item || !snap) {
      galleryBackgroundMenu(event);
      return;
    }
    const key = item.dataset.item!;
    // 右键未选中的项：只对该项操作，清掉现有选择避免误伤。
    if (!selection.has(key) && selection.size > 0) clearSelection();
    setFocusKey(key);
    if (isFolderKey(key)) {
      const folder = snap.folders[key.slice(2)];
      if (folder) openMenu(event, folderMenu(folder));
    } else {
      const image = snap.images[key];
      if (image) openMenu(event, imageMenu(image));
    }
  }, [clearSelection, folderMenu, galleryBackgroundMenu, imageMenu, openMenu, selection]);

  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number; surface: 'images' | 'packs' } | null>(null);
  const onSurfaceMouseDown = useCallback((event: ReactMouseEvent, which: 'images' | 'packs') => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-item], button, input, a')) return;
    const surface = which === 'images' ? imageSurfaceRef.current : packSurfaceRef.current;
    const layout = which === 'images' ? imageLayout : packLayout;
    const keys = which === 'images' ? imageKeys : packKeys;
    const main = mainScrollRef.current;
    if (!surface || !main) return;
    event.preventDefault();
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const base = additive ? new Set(selection) : new Set<string>();
    const origin = surface.getBoundingClientRect();
    const sx = event.clientX - origin.left;
    const sy = event.clientY - origin.top;
    let moved = false;
    let lastX = event.clientX;
    let lastY = event.clientY;
    let frame: number | null = null;
    const update = () => {
      const rect = surface.getBoundingClientRect();
      const cx = lastX - rect.left;
      const cy = lastY - rect.top;
      const x = Math.min(sx, cx);
      const y = Math.min(sy, cy);
      const w = Math.abs(cx - sx);
      const h = Math.abs(cy - sy);
      if (!moved && Math.hypot(w, h) < 5) return;
      moved = true;
      setMarquee({ x, y, w, h, surface: which });
      const next = new Set(base);
      for (const i of itemsInRect(layout, { x, y, w, h })) next.add(keys[i]!);
      setSelection(next);
    };
    const schedule = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        update();
      });
    };
    // 拖到滚动区上下边缘时自动滚动，框选范围跟着扩展（命中按布局几何计算，未挂载的行也算）。
    const autoTimer = window.setInterval(() => {
      if (!moved) return;
      const rect = main.getBoundingClientRect();
      const dy = lastY > rect.bottom - 36 ? 16 : lastY < rect.top + 36 ? -16 : 0;
      if (dy) {
        main.scrollTop += dy;
        schedule();
      }
    }, 30);
    const onMove = (e: MouseEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      schedule();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.clearInterval(autoTimer);
      if (frame != null) cancelAnimationFrame(frame);
      setMarquee(null);
      if (!moved && !additive) clearSelection();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [clearSelection, imageKeys, imageLayout, packKeys, packLayout, selection]);

  // ———————————————————— 键盘 ————————————————————
  const scrollKeyIntoView = useCallback((key: string) => {
    const main = mainScrollRef.current;
    const surface = primary.surfaceRef.current;
    const i = primary.keys.indexOf(key);
    if (!main || !surface || i < 0) return;
    const box = primary.layout.itemBox(i);
    const rowH = primary.layout.rowHeight(primary.layout.rowOf(i));
    const top = surface.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop + box.y;
    const stickyOffset = isRoot ? 8 : 60;
    if (top - stickyOffset < main.scrollTop) main.scrollTop = top - stickyOffset;
    else if (top + rowH + 16 > main.scrollTop + main.clientHeight) main.scrollTop = top + rowH + 16 - main.clientHeight;
  }, [isRoot, primary]);

  const moveFocus = useCallback((key: NavKey) => {
    const keys = primary.keys;
    if (keys.length === 0) return;
    const current = focusKey ? keys.indexOf(focusKey) : -1;
    const next = current < 0 ? 0 : neighborIndex(primary.layout, current, key, mainScrollRef.current?.clientHeight ?? 0);
    if (next < 0) return;
    const nextKey = keys[next]!;
    setFocusKey(nextKey);
    requestAnimationFrame(() => scrollKeyIntoView(nextKey));
  }, [focusKey, primary, scrollKeyIntoView]);

  const setThumbStep = useCallback((dir: 1 | -1) => {
    if (isRoot) setPref('coverSize', Math.max(COVER_SIZE.min, Math.min(COVER_SIZE.max, prefs.coverSize + dir * COVER_SIZE.step)));
    else setPref('thumbSize', Math.max(THUMB_SIZE.min, Math.min(THUMB_SIZE.max, prefs.thumbSize + dir * THUMB_SIZE.step)));
  }, [isRoot, prefs.coverSize, prefs.thumbSize, setPref]);

  const openPalette = useCallback((query = '') => {
    setContextMenu(null);
    setTaskPopoverOpen(false);
    setPalette({ query });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing = target instanceof HTMLElement && target.matches('input:not([type=range]), textarea, select, [contenteditable="true"]');
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (dialog || palette || contextMenu) return;
      if (ctrl && key === 'k') {
        event.preventDefault();
        if (!viewerImageId) openPalette();
        return;
      }
      if (viewerImageId) return; // 查看器自己处理按键
      if (ctrl && key === ',') {
        event.preventDefault();
        setSettings({});
        return;
      }
      if (ctrl && key === 'o') {
        event.preventDefault();
        void runImport();
        return;
      }
      if (ctrl && key === 'b') {
        event.preventDefault();
        setSidebarHidden((v) => !v);
        return;
      }
      if (ctrl && key === 'i') {
        event.preventDefault();
        setInspectorOpen((v) => !v);
        return;
      }
      if (event.altKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
        event.preventDefault();
        if (key === 'ArrowLeft') handleNavBack();
        else handleNavForward();
        return;
      }
      if (typing || settings) return;
      if (ctrl && (key === '=' || key === '+' || key === '-')) {
        event.preventDefault();
        setThumbStep(key === '-' ? -1 : 1);
        return;
      }
      if (ctrl && key === 'a') {
        event.preventDefault();
        selectAll();
        return;
      }
      if (key === '?') {
        setDialog({ kind: 'shortcuts' });
        return;
      }
      if (key === 'Escape') {
        if (taskPopoverOpen) return;
        if (selection.size > 0) clearSelection();
        else if (focusKey) setFocusKey(null);
        else if (filterText) setFilterText('');
        return;
      }
      if (key === 'Delete') {
        if (selectionCount > 0) requestDelete(selectedImages, selectedFolders);
        else if (focusKey && snapshot) {
          if (isFolderKey(focusKey)) {
            const folder = snapshot.folders[focusKey.slice(2)];
            if (folder) requestDelete([], [folder]);
          } else if (snapshot.images[focusKey]) requestDelete([snapshot.images[focusKey]!], []);
        }
        return;
      }
      if (key === 'F2') {
        const k = selection.size === 1 ? [...selection][0]! : focusKey;
        if (k) {
          event.preventDefault();
          renameKey(k);
        }
        return;
      }
      const navMap: Record<string, NavKey> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end', PageUp: 'pageUp', PageDown: 'pageDown' };
      if (navMap[key]) {
        event.preventDefault();
        moveFocus(navMap[key]!);
        return;
      }
      // 焦点在按钮 / 复选框等控件上时，Enter 与空格交给控件本身。
      const onControl = target instanceof HTMLElement && !!target.closest('button, a, [role="checkbox"], [role="switch"], summary');
      if ((key === 'Enter' || key === ' ') && onControl) return;
      if (key === 'Enter') {
        if (selectedImages.length > 1 && selectedFolders.length === 0) {
          event.preventDefault();
          const list = galleryImages.filter((image) => selection.has(image.id));
          if (list.length) openViewer(list[0]!, list);
        } else if (focusKey) {
          event.preventDefault();
          activateKey(focusKey);
        }
        return;
      }
      if (key === ' ' && focusKey) {
        event.preventDefault();
        toggleSelect(focusKey, event.shiftKey);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activateKey, clearSelection, contextMenu, dialog, filterText, focusKey, galleryImages, handleNavBack, handleNavForward, moveFocus, openPalette, openViewer, palette, renameKey, requestDelete, runImport, selectAll, selectedFolders, selectedImages, selection, selectionCount, setThumbStep, settings, snapshot, taskPopoverOpen, toggleSelect, viewerImageId]);

  // 鼠标侧键：浏览时后退 / 前进；查看器里上一张 / 下一张。输入框聚焦时不触发。
  useEffect(() => {
    const onSideButton = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type !== 'mouseup') return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
      const dir = event.button === 3 ? -1 : 1;
      if (viewerImageId) {
        const idx = viewerImages.findIndex((img) => img.id === viewerImageId);
        if (idx >= 0 && viewerImages.length > 0) setViewerImageId(viewerImages[(idx + dir + viewerImages.length) % viewerImages.length]!.id);
        return;
      }
      if (dialog || palette) return;
      if (dir < 0) handleNavBack();
      else handleNavForward();
    };
    window.addEventListener('mousedown', onSideButton);
    window.addEventListener('mouseup', onSideButton);
    window.addEventListener('auxclick', onSideButton);
    return () => {
      window.removeEventListener('mousedown', onSideButton);
      window.removeEventListener('mouseup', onSideButton);
      window.removeEventListener('auxclick', onSideButton);
    };
  }, [dialog, handleNavBack, handleNavForward, palette, viewerImageId, viewerImages]);

  // ———————————————————— 检查器数据 ————————————————————
  const singleFolderSelected = selectedFolders.length === 1 && selectionCount === 1;
  const inspectorFolder = singleFolderSelected ? selectedFolders[0]! : selectedFolder;
  const inspectorImages = useMemo(() => {
    if (!snapshot || !inspectorFolder) return [];
    if (inspectorFolder.id === selectedFolder?.id) return folderAllImages;
    return imagesOf(snapshot, inspectorFolder.id);
  }, [folderAllImages, inspectorFolder, selectedFolder, snapshot]);
  const inspectorIsRoot = !!inspectorFolder && inspectorFolder.id === rootId;
  const inspectorCover = inspectorFolder && !inspectorIsRoot ? coverFor(inspectorFolder.id) : null;

  const organizeHint = useMemo<OrganizeHint | null>(() => {
    // 解析文件名是 O(n) 的；超大图包切换时不为一条提示卡住主线程，整理入口仍在页头。
    if (!inspectorOpen || !snapshot || inspectorIsRoot || !inspectorFolder) return null;
    // 与整理对话框的默认范围一致：有直属图片时只看直属图片。
    const scope = organizeIncludesSubfoldersByDefault(inspectorFolder) ? inspectorImages : directImagesOf(snapshot, inspectorFolder.id);
    if (scope.length < 4 || scope.length > ORGANIZE_HINT_MAX) return null;
    const planned = planBindings(scope, customRules);
    const options = ruleOptions(planned, customRules).filter((o) => o.id !== AUTO_RULE_ID && o.hitCount > 0);
    let best: OrganizeHint | null = null;
    for (const option of options.sort((a, b) => b.hitCount - a.hitCount).slice(0, 3)) {
      const groups = previewGroups(bindingsForRule(planned, option.id)).length;
      if (groups >= 2 && (!best || option.hitCount > best.moved)) best = { ruleId: option.id, ruleName: option.name, moved: option.hitCount, groups };
    }
    return best;
  }, [customRules, inspectorFolder, inspectorImages, inspectorIsRoot, inspectorOpen, snapshot]);

  // ———————————————————— 命令 ————————————————————
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [
      { id: 'import', label: '导入文件夹…', icon: <UploadSimple size={16} />, shortcut: 'Ctrl O', run: () => void runImport(), keywords: 'import' },
    ];
    if (!isRoot && selectedFolder) {
      list.push(
        { id: 'organize', label: `智能整理「${selectedFolder.name}」`, icon: <MagicWand size={16} />, run: () => setDialog({ kind: 'organize', folderId: selectedFolder.id }), keywords: 'organize' },
        { id: 'export', label: `导出「${selectedFolder.name}」为 ZIP`, icon: <FileZip size={16} />, run: () => exportFolder(selectedFolder), keywords: 'zip export' },
        { id: 'cover', label: `设置「${selectedFolder.name}」的封面`, icon: <ImageSquare size={16} />, run: () => setDialog({ kind: 'cover', folderId: selectedFolder.id }) },
      );
    }
    if (lastUndo) list.push({ id: 'undo', label: UNDO_LABEL[lastUndo.kind], icon: <ArrowCounterClockwise size={16} />, run: () => void handleUndo() });
    list.push(
      { id: 'rescan', label: '重新扫描图库', icon: <ArrowClockwise size={16} />, run: () => void refresh().then(() => notify('已重新扫描图库', 'success')), keywords: 'refresh rescan' },
      {
        id: 'theme',
        label: effectiveTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        icon: effectiveTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />,
        run: () => setTheme(effectiveTheme === 'dark' ? 'light' : 'dark'),
        keywords: 'theme dark light 主题',
      },
      { id: 'settings', label: '打开设置', icon: <GearSix size={16} />, shortcut: 'Ctrl ,', run: () => setSettings({}), keywords: 'settings' },
      { id: 'keys', label: '键盘快捷键', icon: <Keyboard size={16} />, shortcut: '?', run: () => setDialog({ kind: 'shortcuts' }), keywords: 'shortcuts keyboard' },
      { id: 'sidebar', label: sidebarHidden ? '显示侧栏' : '隐藏侧栏', icon: <SidebarSimple size={16} />, shortcut: 'Ctrl B', run: () => setSidebarHidden((v) => !v) },
      { id: 'inspector', label: inspectorOpen ? '隐藏检查器' : '显示检查器', icon: <SidebarSimple size={16} mirrored />, shortcut: 'Ctrl I', run: () => setInspectorOpen((v) => !v) },
      {
        id: 'tasks',
        label: '打开任务中心',
        icon: <ListChecks size={16} />,
        run: () => {
          setTaskPopoverOpen(true);
          setTasksUnseen(false);
        },
      },
    );
    return list;
  }, [effectiveTheme, exportFolder, handleUndo, inspectorOpen, isRoot, lastUndo, notify, refresh, runImport, selectedFolder, sidebarHidden]);

  const filterCommand = useCallback((query: string): PaletteCommand | null => {
    if (isRoot || !selectedFolder) return null;
    return { id: 'filter', label: `在「${selectedFolder.name}」的网格中筛选「${query}」`, icon: <MagnifyingGlass size={16} />, run: () => setFilterText(query) };
  }, [isRoot, selectedFolder]);

  // ———————————————————— 渲染片段 ————————————————————
  const continueItems = useMemo<ContinueCardData[]>(() => {
    if (!snapshot || !isRoot || libFilter !== 'all') return [];
    const { items } = resolveContinueItems(snapshot, recentBrowse);
    return items.slice(0, CONTINUE_LIMIT).map((item) => ({
      folder: snapshot.folders[item.folderId]!,
      image: snapshot.images[item.imageId]!,
      position: item.position,
      total: item.total,
    }));
  }, [isRoot, libFilter, recentBrowse, snapshot]);

  const resume = useCallback((item: ContinueCardData) => {
    // 继续浏览的位置可能在子图包里：打开图片所在的图包，查看器从该图开始。
    const snap = snapshotRef.current;
    if (!snap) return;
    selectFolder(item.image.folderId);
    const list = sortImages(
      prefs.includeSubfolders ? imagesOf(snap, item.image.folderId) : directImagesOf(snap, item.image.folderId),
      prefs.sort,
      prefs.sortDir,
    );
    openViewer(item.image, list);
  }, [openViewer, prefs.includeSubfolders, prefs.sort, prefs.sortDir, selectFolder]);

  const renderPackItem = useCallback((i: number, box: ItemBox, rowHeight: number) => {
    const data = packItems[i];
    if (!data) return null;
    const key = folderKey(data.folder.id);
    const coverBlurred = data.cover ? blurredImages.has(data.cover.relPath) : false;
    if (packLayout.mode === 'list') {
      return <PackListRow key={key} data={data} box={box} store={store} selected={selection.has(key)} focused={focusKey === key} coverBlurred={coverBlurred} />;
    }
    return <PackCard key={key} data={data} box={box} rowHeight={rowHeight} store={store} selected={selection.has(key)} focused={focusKey === key} coverBlurred={coverBlurred} />;
  }, [blurredImages, focusKey, packItems, packLayout.mode, selection, store]);

  const renderImageItem = useCallback((i: number, box: ItemBox, rowHeight: number) => {
    const image = galleryImages[i];
    if (!image) return null;
    const folderLabel = prefs.includeSubfolders && image.folderId !== currentFolderId ? snapshot?.folders[image.folderId]?.name : undefined;
    const blurred = blurredImages.has(image.relPath);
    if (imageLayout.mode === 'list') {
      return <ImageListRow key={image.id} image={image} box={box} store={store} selected={selection.has(image.id)} focused={focusKey === image.id} blurred={blurred} folderLabel={folderLabel} />;
    }
    return (
      <ImageCell
        key={image.id}
        image={image}
        box={box}
        rowHeight={rowHeight}
        store={store}
        selected={selection.has(image.id)}
        focused={focusKey === image.id}
        blurred={blurred}
        showName={prefs.showNames}
        folderLabel={folderLabel}
        justified={imageLayout.mode === 'justified'}
      />
    );
  }, [blurredImages, currentFolderId, focusKey, galleryImages, imageLayout.mode, prefs.includeSubfolders, prefs.showNames, selection, snapshot, store]);

  const marqueeBox = (which: 'images' | 'packs') =>
    marquee && marquee.surface === which ? <div className="dk-marq" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} /> : null;

  const packSurface = (
    <div
      className={`dk-grid-area ${selection.size > 0 ? 'selecting' : ''}`}
      onClick={onSurfaceClick}
      onContextMenu={onSurfaceContextMenu}
      onMouseDown={(event) => onSurfaceMouseDown(event, 'packs')}
    >
      {isRoot && prefs.packView === 'list' && (
        <ListHeader<PackSort>
          className="dk-pack-row"
          columns={PACK_LIST_COLUMNS}
          active={prefs.packSort}
          onSort={(key) => setPref('packSort', key)}
        />
      )}
      <div style={{ position: 'relative' }}>
        <VirtualSurface layout={packLayout} scrollRef={mainScrollRef} surfaceRef={packSurfaceRef} renderItem={renderPackItem} label="图包" />
        {marqueeBox('packs')}
      </div>
    </div>
  );

  // ———————————————————— 页面 ————————————————————
  const renderHome = () => (
    <>
      <HomeHeader filter={libFilter} packCount={topFolders.length} imageCount={allImages.length} bytes={libraryBytes} onFilter={setLibFilter} />
      <ContinueBrowsing items={continueItems} store={store} blurredImages={blurredImages} onResume={resume} />
      <SectionHeader title="图包" count={homePacks.length}>
        {libFilter !== 'recent' && (
          <PackViewControls sort={prefs.packSort} view={prefs.packView} onSortMenu={packSortMenu} onView={(view) => setPref('packView', view)} />
        )}
      </SectionHeader>
      {homePacks.length > 0 ? (
        packSurface
      ) : (
        <EmptyState
          icon={libFilter === 'pinned' ? <PushPin size={24} /> : <UploadSimple size={24} />}
          title={libFilter === 'pinned' ? '还没有固定封面的图包' : '最近 7 天没有导入图包'}
          text={libFilter === 'pinned' ? '在图包上右键「设置封面…」固定一张图，它会出现在这里。' : '导入记录只保存在本机。'}
        />
      )}
    </>
  );

  const renderPack = () => {
    if (!selectedFolder) return null;
    const cover = coverFor(selectedFolder.id);
    const coverPinned = pinnedCovers[selectedFolder.id] != null;
    const allBlurred = folderAllImages.length > 0 && folderAllImages.every((image) => blurredImages.has(image.relPath));
    const subStrip: SubPackData[] = subPacks.slice(0, SUBPACK_STRIP_LIMIT).map((d) => ({ folder: d.folder, cover: d.cover, bytes: d.bytes }));
    const heroMenuSkip = new Set(['打开', '智能整理…', '设置封面…', '导出 ZIP…']);
    return (
      <>
        <PackHero
          store={store}
          folder={selectedFolder}
          crumbs={crumbs}
          cover={cover}
          coverPinned={coverPinned}
          coverBlurred={cover ? blurredImages.has(cover.relPath) : false}
          imageCount={folderAllImages.length}
          bytes={folderBytes.get(selectedFolder.id) ?? 0}
          importedLabel={selectedFolder.parentId === rootId ? topImportedLabel(selectedFolder.id) : undefined}
          busy={busy}
          exporting={exporting}
          allBlurred={allBlurred}
          undoLabel={lastUndo ? UNDO_LABEL[lastUndo.kind] : null}
          onCrumb={openFolder}
          onRoot={() => goRoot('all')}
          onOrganize={() => setDialog({ kind: 'organize', folderId: selectedFolder.id })}
          onExport={() => exportFolder(selectedFolder)}
          onCover={() => setDialog({ kind: 'cover', folderId: selectedFolder.id })}
          onToggleBlur={() => toggleFolderBlur(selectedFolder)}
          onUndo={() => void handleUndo()}
          onMore={(anchor) => openMenuBelow(anchor, folderMenu(selectedFolder).filter((item) => !heroMenuSkip.has(item.label)).map((item, i) => (i === 0 ? { ...item, separator: false } : item)))}
        />
        {subPacks.length > 0 && (
          <>
            <SectionHeader title="子图包" count={subPacks.length}>
              {subpacksExpanded && <button type="button" className="dk-dd" onClick={() => setSubpacksExpanded(false)}>收起为横向卡片</button>}
            </SectionHeader>
            {subpacksExpanded ? (
              packSurface
            ) : (
              <SubPackStrip
                items={subStrip}
                total={subPacks.length}
                store={store}
                blurredImages={blurredImages}
                onOpen={openFolder}
                onContextMenu={(event, folder) => openMenu(event, folderMenu(folder))}
                onShowAll={() => setSubpacksExpanded(true)}
                onCreate={() => createFolderIn(selectedFolder)}
              />
            )}
          </>
        )}
        <div ref={toolbarSentinelRef} className="dk-sentinel" aria-hidden="true" />
        <ImageToolbar
          toolbarRef={toolbarRef}
          stuck={toolbarStuck}
          store={store}
          folder={selectedFolder}
          cover={cover}
          coverBlurred={cover ? blurredImages.has(cover.relPath) : false}
          count={galleryImages.length}
          hasChildren={selectedFolder.childCount > 0}
          includeSubfolders={prefs.includeSubfolders}
          filterText={filterText}
          sort={prefs.sort}
          sortDir={prefs.sortDir}
          layout={prefs.layout}
          showNames={prefs.showNames}
          inspectorOpen={inspectorOpen}
          onToggleSubfolders={() => setPref('includeSubfolders', !prefs.includeSubfolders)}
          onClearFilter={() => setFilterText('')}
          onSortMenu={imageSortMenu}
          onLayout={(layout) => setPref('layout', layout)}
          onToggleNames={() => setPref('showNames', !prefs.showNames)}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
        />
        {galleryImages.length > 0 ? (
          <div
            className={`dk-grid-area ${selection.size > 0 ? 'selecting' : ''} ${prefs.layout === 'list' ? 'list' : ''}`}
            style={{ ['--dk-rad' as string]: `${gridRadius(prefs.thumbSize)}px` }}
            onClick={onSurfaceClick}
            onContextMenu={onSurfaceContextMenu}
            onMouseDown={(event) => onSurfaceMouseDown(event, 'images')}
          >
            {prefs.layout === 'list' && (
              <ListHeader<ImageSort>
                columns={IMAGE_LIST_COLUMNS}
                active={prefs.sort}
                dir={prefs.sortDir}
                onSort={(key) => {
                  // 与 demo 一致：再点当前列切换升降序，换列时保持当前方向。
                  if (key === prefs.sort) setPref('sortDir', prefs.sortDir === 'asc' ? 'desc' : 'asc');
                  else setPref('sort', key);
                }}
              />
            )}
            <div style={{ position: 'relative' }}>
              <VirtualSurface
                layout={imageLayout}
                scrollRef={mainScrollRef}
                surfaceRef={imageSurfaceRef}
                renderItem={renderImageItem}
                onWindowChange={onImageWindowChange}
                label="图片"
              />
              {marqueeBox('images')}
            </div>
          </div>
        ) : (
          <div onContextMenu={galleryBackgroundMenu}>
            <EmptyState
              icon={filterText ? <MagnifyingGlass size={24} /> : <ImageSquare size={24} />}
              title={filterText ? '没有匹配的图片' : '这个图包里没有直属图片'}
              text={
                filterText
                  ? `没有文件名包含「${filterText}」的图片。`
                  : selectedFolder.childCount > 0
                    ? '图片都在子图包里，可以打开「含子目录」一起浏览。'
                    : '导入文件夹，或把其他图包里的图片移到这里。'
              }
              action={
                filterText ? (
                  <button type="button" className="dk-btn" onClick={() => setFilterText('')}>清除筛选</button>
                ) : selectedFolder.childCount > 0 && !prefs.includeSubfolders ? (
                  <button type="button" className="dk-btn" onClick={() => setPref('includeSubfolders', true)}>显示子目录中的图片</button>
                ) : undefined
              }
            />
          </div>
        )}
      </>
    );
  };

  // ———————————————————— 整体 ————————————————————
  const showSidebar = !sidebarHidden && !settings;
  const showInspector = inspectorOpen && !settings && !isEmptyLibrary && !!snapshot;
  const statusLeft = isRoot ? (
    <span className="num">{formatCount(homePacks.length)} 个图包</span>
  ) : (
    <>
      <span className="num">{formatCount(galleryImages.length)} 张 · {formatBytes(galleryImages.reduce((sum, image) => sum + image.size, 0))}</span>
      {selectionCount > 0 && (
        <>
          <span className="dk-sep" />
          <span className="dk-sel-text">已选 {formatCount(selectionCount)} 项</span>
        </>
      )}
    </>
  );
  const zoomControl = isEmptyLibrary
    ? null
    : isRoot
      ? prefs.packView === 'grid' && homePacks.length > 0
        ? { value: prefs.coverSize, min: COVER_SIZE.min, max: COVER_SIZE.max, onChange: (v: number) => setPref('coverSize', v), onStep: setThumbStep }
        : null
      : prefs.layout !== 'list' && galleryImages.length > 0
        ? { value: prefs.thumbSize, min: THUMB_SIZE.min, max: THUMB_SIZE.max, onChange: (v: number) => setPref('thumbSize', v), onStep: setThumbStep }
        : null;

  const viewerImage = viewerIndex >= 0 ? viewerImages[viewerIndex] ?? null : null;
  // Snackbar 放在内容区左下角，避开侧栏（设置页的左栏固定 244px）。
  const snackLeft = viewerImage || compact ? 18 : settings ? (sidebarHidden ? 18 : 244 + 18) : showSidebar ? sidebarWidth + 18 : 18;

  return (
    <div
      ref={libraryRootRef}
      className="dk-root"
      onWheel={(event) => {
        if (!event.ctrlKey || settings || viewerImageId || !(event.target as HTMLElement).closest('.dk-main-scroll')) return;
        setThumbStep(event.deltaY > 0 ? -1 : 1);
      }}
    >
      <TitleBar
        canGoBack={!!settings || canGoBack(nav)}
        canGoForward={!settings && canGoForward(nav)}
        onBack={handleNavBack}
        onForward={handleNavForward}
        onToggleSidebar={() => setSidebarHidden((v) => !v)}
        searchPlaceholder={!isRoot && selectedFolder ? `在「${selectedFolder.name}」中搜索，或输入命令` : '搜索图包、图片或命令'}
        onOpenPalette={() => openPalette()}
        showSearch={!settings}
        taskButton={
          <TaskButton
            tasks={tasks}
            unseen={tasksUnseen}
            open={taskPopoverOpen}
            buttonRef={taskButtonRef}
            onToggle={() => {
              setTaskPopoverOpen((v) => !v);
              setTasksUnseen(false);
            }}
          />
        }
        importing={importing}
        onImport={() => void runImport()}
      />

      <div className="dk-body">
        {settings ? (
          <SettingsPage
            rules={customRules}
            onChange={handleCustomRulesChange}
            onBack={() => setSettings(null)}
            runtimeLabel={window.kanitsuDesktop?.platform === 'electron' ? 'Electron' : 'Web'}
            libraryBytes={libraryBytes}
            libraryFileCount={allImages.length}
            theme={theme}
            accent={accent}
            onThemeChange={setTheme}
            onAccentChange={setAccent}
            rawViewMode={rawViewMode}
            onRawViewModeChange={handleRawViewModeChange}
            initialTab={settings.tab}
            sidebarHidden={sidebarHidden}
          />
        ) : (
          <>
            {showSidebar && (
              <Sidebar
                width={sidebarWidth}
                onResize={setSidebarWidth}
                overlay={compact}
                snapshot={snapshot}
                store={store}
                isRoot={isRoot}
                filter={libFilter}
                counts={filterCounts}
                selectedFolderId={currentFolderId}
                expandedFolders={expandedFolders}
                onToggleFolder={toggleFolderExpanded}
                onSelectFolder={openFolder}
                onSelectFilter={goRoot}
                onFolderContextMenu={(event, folder) => openMenu(event, folderMenu(folder))}
                onRootContextMenu={(event) => {
                  const root = snapshot?.folders[rootId];
                  if (root) openMenu(event, folderMenu(root));
                }}
                onNewFolder={() => {
                  const parent = !isRoot && selectedFolder ? selectedFolder : snapshot?.folders[rootId];
                  if (parent) createFolderIn(parent);
                }}
                onOpenSettings={() => setSettings({})}
                coverFor={coverFor}
                blurredImages={blurredImages}
                freshFolders={freshFolders}
                libraryBytes={libraryBytes}
                imageCount={allImages.length}
              />
            )}
            <main
              className="dk-main"
              // 窄窗口下侧栏是浮层：点内容区即收起，与抽屉的习惯一致。
              onMouseDownCapture={compact && !sidebarHidden ? () => setSidebarHidden(true) : undefined}
            >
              <div
                ref={(node) => {
                  mainScrollRef.current = node;
                }}
                className="dk-scroll dk-main-scroll"
                tabIndex={-1}
              >
                {isEmptyLibrary ? (
                  <FirstRun canDrop={canDrop} importing={importing} onImport={() => void runImport()} />
                ) : isRoot ? (
                  renderHome()
                ) : (
                  renderPack()
                )}
              </div>
              <StatusBar left={statusLeft} task={runningTask ? { title: runningTask.title, done: runningTask.done, total: runningTask.total } : null} zoom={zoomControl} />
              <SelectionBar
                imageCount={selectedImages.length}
                folderCount={selectedFolders.length}
                busy={busy}
                canExport={!!store.zipSelection}
                allBlurred={selectionAllBlurred}
                onMove={() => requestMove(selectedImages.map((i) => i.id), selectedFolders.map((f) => f.id))}
                onCover={selectedImages.length === 1 && selectedFolders.length === 0 ? () => toggleImagePin(selectedImages[0]!) : null}
                onBlur={toggleSelectionBlur}
                onExport={exportSelection}
                onMerge={() => requestMerge(selectedImages.map((i) => i.id), selectedFolders.map((f) => f.id))}
                onDelete={() => requestDelete(selectedImages, selectedFolders)}
                onClear={clearSelection}
              />
            </main>
            {showInspector && (
              <Inspector
                store={store}
                overlay={narrow}
                folder={inspectorFolder}
                isRoot={inspectorIsRoot}
                folderImages={inspectorImages}
                childFolderCount={inspectorFolder ? (inspectorIsRoot ? topFolders.length : inspectorFolder.childCount) : 0}
                cover={inspectorCover}
                coverPinned={inspectorFolder ? pinnedCovers[inspectorFolder.id] != null : false}
                importedLabel={inspectorFolder && inspectorFolder.parentId === rootId ? topImportedLabel(inspectorFolder.id) : undefined}
                selectedImages={selectedImages}
                selectedFolders={singleFolderSelected ? [] : selectedFolders}
                selectedFolderCovers={selectedFolders.map((f) => coverFor(f.id)).filter((image): image is ImageEntry => Boolean(image))}
                selectedFolderStats={selectedFolderStats}
                blurredImages={blurredImages}
                pinnedCovers={pinnedCovers}
                organizeHint={organizeHint}
                busy={busy}
                onClose={() => setInspectorOpen(false)}
                onOpenImage={(image) => openViewer(image)}
                onToggleImageBlur={toggleImageBlur}
                onPinImage={toggleImagePin}
                onRenameImage={renameImageAction}
                onImageMenu={(image, anchor) => openMenuBelow(anchor, imageMenu(image))}
                onViewSelection={() => {
                  const list = galleryImages.filter((image) => selection.has(image.id));
                  if (list.length) openViewer(list[0]!, list);
                }}
                onSelectAll={selectAll}
                onClearSelection={clearSelection}
                onOrganize={() => inspectorFolder && setDialog({ kind: 'organize', folderId: inspectorFolder.id, ruleId: organizeHint?.ruleId })}
                onCreateFolder={() => inspectorFolder && createFolderIn(inspectorFolder)}
                onRenameFolder={() => inspectorFolder && renameFolderAction(inspectorFolder)}
                onCopyFolderPath={() => inspectorFolder && void copyPath(inspectorFolder.relPath)}
                onDeleteFolder={() => inspectorFolder && requestDelete([], [inspectorFolder])}
              />
            )}
          </>
        )}
      </div>

      {/* 查看器按图片 id 重挂载（切图即重置缩放 / 平移 / 旋转）。外层底板不随切图重挂载：
          打开时只淡入一次，切图的瞬间也始终盖住主界面，不会露出底下的页面（浅色主题下会闪白）。 */}
      {viewerImage && (
        <div className="dk-viewer-shell">
        <Viewer
          key={viewerImage.id}
          images={viewerImages}
          index={viewerIndex}
          store={store}
          onClose={closeViewer}
          onNavigate={setViewerImageId}
          onSwitchSibling={handleViewerSwitchSibling}
          onImageContextMenu={(event, image) => openMenu(event, imageMenu(image))}
          rawViewMode={rawViewMode}
          onRawViewModeChange={handleRawViewModeChange}
          infoOpen={viewerInfoOpen}
          onInfoOpenChange={setViewerInfoOpen}
          filmstripVisible={filmstripVisible}
          onToggleFilmstrip={() => setFilmstripVisible((v) => !v)}
          idle={viewerIdle && !contextMenu && !dialog}
          folderName={snapshot?.folders[viewerImage.folderId]?.name}
          blurred={blurredImages.has(viewerImage.relPath)}
          revealed={revealed.has(viewerImage.id)}
          onReveal={() => setRevealed((prev) => new Set(prev).add(viewerImage.id))}
          pinned={pinnedCovers[viewerImage.folderId] === viewerImage.id}
          onTogglePin={toggleImagePin}
          onToggleBlur={toggleImageBlur}
          onDelete={(image) => requestDelete([image], [])}
          blurredImages={blurredImages}
        />
        </div>
      )}

      {taskPopoverOpen && (
        <TaskPopover
          tasks={tasks}
          anchorRef={taskButtonRef}
          reportOpen={taskReportOpen}
          onToggleReport={(id) =>
            setTaskReportOpen((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onCancel={(id) => taskCancelRef.current.get(id)?.()}
          onUndo={(id) => void handleUndo(id)}
          onOpenFolder={(folderId) => {
            setTaskPopoverOpen(false);
            setViewerImageId(null);
            selectFolder(folderId);
          }}
          onClearFinished={() => setTasks((prev) => prev.filter((t) => t.status === 'running'))}
          onClose={() => setTaskPopoverOpen(false)}
        />
      )}

      {palette && (
        <CommandPalette
          snapshot={snapshot}
          store={store}
          scopeFolder={isRoot ? null : selectedFolder}
          blurredImages={blurredImages}
          coverFor={coverFor}
          commands={paletteCommands}
          filterCommand={filterCommand}
          initialQuery={palette.query}
          onOpenFolder={openFolder}
          onOpenImage={(image) => {
            const snap = snapshotRef.current;
            if (!snap) return;
            if (galleryImages.some((g) => g.id === image.id)) {
              openViewer(image);
              return;
            }
            selectFolder(image.folderId);
            openViewer(image, sortImages(directImagesOf(snap, image.folderId), prefs.sort, prefs.sortDir));
          }}
          onClose={() => setPalette(null)}
        />
      )}

      {dialog?.kind === 'prompt' && <PromptDialog options={dialog.options} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && snapshot && (
        <DeleteDialog
          request={dialog.request}
          snapshot={snapshot}
          store={store}
          blurredImages={blurredImages}
          coverFor={coverFor}
          onConfirm={() => void confirmDelete(dialog.request)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'move' && snapshot && (
        <MoveDialog
          count={dialog.imageIds.length + dialog.folderIds.length}
          snapshot={snapshot}
          store={store}
          blurredImages={blurredImages}
          coverFor={coverFor}
          initialExpanded={expandedFolders}
          isDisabled={(folder) => {
            const movingRels = dialog.folderIds.map((id) => snapshot.folders[id]?.relPath).filter((rel): rel is string => !!rel);
            return movingRels.some((rel) => folder.relPath === rel || folder.relPath.startsWith(`${rel}/`));
          }}
          onCreateFolder={(parent, onCreated) => {
            const moveState = dialog;
            createFolderIn(parent, (created) => {
              setDialog(moveState);
              onCreated(created);
            });
          }}
          onConfirm={(target) => void confirmMove(dialog.imageIds, dialog.folderIds, target)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'cover' && snapshot && (
        <CoverDialog
          folderId={dialog.folderId}
          snapshot={snapshot}
          store={store}
          pinnedCovers={pinnedCovers}
          blurredImages={blurredImages}
          onPick={(imageId) => pinCover(dialog.folderId, imageId, imageId ? snapshot.images[imageId]?.name : undefined)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'organize' && snapshot && snapshot.folders[dialog.folderId] && (
        <OrganizeDialog
          folder={snapshot.folders[dialog.folderId]!}
          snapshot={snapshot}
          customRules={customRules}
          store={store}
          blurredImages={blurredImages}
          initialRuleId={dialog.ruleId}
          onApply={(bindings, ruleName) => void applyOrganizePlan(snapshot.folders[dialog.folderId]!, bindings, ruleName)}
          onClose={() => setDialog(null)}
          onManageRules={() => {
            setDialog(null);
            setSettings({ tab: 'rules' });
          }}
        />
      )}
      {dialog?.kind === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}

      {dragCount > 0 && !dialog && !viewerImageId && <DropOverlay count={dragCount} />}

      <Snackbar snack={snack} left={snackLeft} onClose={() => setSnack(null)} />
      <ContextMenu menu={contextMenu} container={libraryRootRef.current} onClose={() => setContextMenu(null)} />
    </div>
  );
}
