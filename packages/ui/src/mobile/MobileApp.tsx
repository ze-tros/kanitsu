import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  type ImportTask,
  type LibrarySnapshot,
  type OrganizeBinding,
  type OrganizeManifest,
  type OrganizeResult,
  type PersistentIndex,
} from '../../../core/src/index';
import type { FileRef, ImportSourcePicker, LibraryStore } from '../../../fs-adapter/src/types';
import { organizeByFolder, type CustomOrganizeRule } from '../../../organizer/src/index';
import { pickCover } from '../../../cover-picker/src/index';
import { BlobImage } from '../BlobImage';
import { KanitsuLogo } from '../KanitsuLogo';
import {
  COVER_THUMBNAIL_SIZE,
  preloadThumbnails,
  setThumbnailPreloadPaused,
  THUMB_PRIORITY_CURRENT_DIR,
  THUMB_PRIORITY_DIRECTIONAL,
  THUMB_PRIORITY_SUBFOLDER,
  THUMB_PRIORITY_WARMUP,
} from '../thumbnailCache';
import { isPrefetchEnabled, logDebug } from '../debugLog';
import { loadCustomRules, saveCustomRules } from '../OrganizeRulesModal';
import { OrganizePreview } from '../OrganizePreview';
import { CoverPickerModal } from '../CoverPickerModal';
import { MobileViewer } from './MobileViewer';
import {
  MobileActionSheet,
  MobileConfirmDialog,
  MobileProgressCard,
  MobilePromptDialog,
  MobileToast,
  type SheetAction,
} from './MobileSheets';
import { MobileSettingsScreen } from './MobileSettingsScreen';
import {
  FOLDER_GRID,
  IMAGE_GRID,
  OVERSCAN_ROWS,
  conflictReasonLabel,
  formatBytes,
  haptic,
  isImageBlurred,
  loadBlurredImages,
  loadPinnedCovers,
  saveBlurredImages,
  savePinnedCovers,
  skippedReasonLabel,
  startThemeModeSync,
} from './mobileShared';
import { Z_BATCH_BAR, Z_DIALOG, Z_DRAWER, Z_SETTINGS } from './zindex';
import { MobileIcon } from './mobileIcons';

// —— 移动端网格参数（单一数据源：mobileShared，避免与库内 IMAGE_GRID 漂移）——
const IMAGE_COLS = IMAGE_GRID.cols;
const IMAGE_GAP = IMAGE_GRID.gap;
/** 图片卡片文件名行高（开关「显示文件名」时参与网格行高计算）。 */
const IMAGE_NAME_H = 16;
const FOLDER_COLS = FOLDER_GRID.cols;
const FOLDER_GAP = FOLDER_GRID.gap;
const FOLDER_CAPTION_H = 50;
// 移动端极高速惯性滚动一帧内可能跨过多行；缓冲 8 行避免视口追上窗口时
// 露出空白，同时仍只保留有限的图片 DOM。
const MOBILE_OVERSCAN_ROWS = Math.max(OVERSCAN_ROWS, 8);
const MOBILE_SCROLL_PRELOAD_RESUME_MS = 180;

type OverlayLayer = 'drawer' | 'sheet' | 'viewer' | 'settings' | 'tools' | 'organize' | 'cover' | 'dialog' | 'report' | 'search';
type StackEntry = { type: 'folder'; folderId: string } | { type: 'overlay'; layer: OverlayLayer };

interface SheetModel {
  title?: string;
  subtitle?: string;
  actions: SheetAction[];
}

type DeleteTarget = { kind: 'image'; image: ImageEntry } | { kind: 'folder'; folder: FolderNode };

type PromptState =
  | { kind: 'rename-image'; image: ImageEntry }
  | { kind: 'rename-folder'; folder: FolderNode }
  | { kind: 'create-folder'; folder: FolderNode }
  | { kind: 'batch-move'; count: number };

type SortMode = 'default' | 'name' | 'date' | 'size';
type SortDirection = 'asc' | 'desc';
const SORT_MODE_LABELS: Record<SortMode, string> = { default: '默认顺序', name: '按名称', date: '按日期', size: '按大小' };

type ToolsScreenProps = {
  onBack: () => void;
  onOpenSettings: () => void;
  onImport: () => void;
  imageCount: number;
  importReport: ImportTask | null;
  lastManifest: OrganizeManifest | null;
  organizing: boolean;
  onOrganize: () => void;
  onExport: () => void;
  onUndo: () => void;
  onShowReport: () => void;
};

function imageToFileRef(image: ImageEntry): FileRef {
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

/** 手指位移超过该值即视为滚动而非长按（原实现移动 1px 就取消，网格里手抖变滚动）。 */
const LONG_PRESS_MOVE_TOLERANCE = 10;

/** 长按手势（移动端替代右键）。带位移阈值 + 触发前按压视觉反馈。 */
function useLongPress(onLongPress: () => void, ms = 460) {
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const [pressing, setPressing] = useState(false);

  const cancel = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPointRef.current = null;
    setPressing(false);
  }, []);

  const start = useCallback(
    (e: React.TouchEvent) => {
      cancel();
      firedRef.current = false;
      const t = e.touches[0];
      startPointRef.current = t ? { x: t.clientX, y: t.clientY } : null;
      setPressing(true);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;
        setPressing(false);
        haptic(18);
        onLongPress();
      }, ms);
    },
    [cancel, onLongPress, ms],
  );

  const move = useCallback(
    (e: React.TouchEvent) => {
      if (timerRef.current == null) return; // 非按压中
      const p = startPointRef.current;
      const t = e.touches[0];
      if (!p || !t) return;
      if (Math.hypot(t.clientX - p.x, t.clientY - p.y) > LONG_PRESS_MOVE_TOLERANCE) cancel();
    },
    [cancel],
  );

  const end = useCallback(() => {
    // 未触发长按的普通触摸（点按/滚动）：清定时器并复位按压态。
    if (timerRef.current != null) cancel();
    else setPressing(false);
  }, [cancel]);

  useEffect(() => cancel, [cancel]);
  return {
    onTouchStart: start,
    onTouchMove: move,
    onTouchEnd: end,
    onTouchCancel: cancel,
    wasLongPress: () => firedRef.current,
    /** 按压中（用于触发前的视觉反馈，替代容易误判的 active:opacity）。 */
    pressing,
  };
}

/** 虚拟化网格：只挂载可视区 ± 缓冲行。 */
function VirtualGrid<T>({
  items,
  cols,
  rowHeight,
  gap,
  scrollTop,
  viewportH,
  sectionTop,
  renderItem,
  getKey,
}: {
  items: T[];
  cols: number;
  rowHeight: number;
  gap: number;
  scrollTop: number;
  viewportH: number;
  sectionTop: number;
  renderItem: (item: T) => ReactNode;
  getKey: (item: T) => string;
}) {
  const totalRows = Math.ceil(items.length / cols);
  if (totalRows === 0 || rowHeight <= 0) return null;
  const gs = Math.max(0, scrollTop - sectionTop);
  const first = Math.max(0, Math.floor(gs / rowHeight) - MOBILE_OVERSCAN_ROWS);
  const last = Math.min(totalRows, Math.ceil((gs + viewportH) / rowHeight) + MOBILE_OVERSCAN_ROWS);
  // 可视行号窗口：窗口未变时复用同一数组，避免每次滚动都重建（万级图时减少 GC）。
  const rowIndexes = useMemo(() => {
    const out: number[] = [];
    for (let r = first; r < last; r++) out.push(r);
    return out;
  }, [first, last]);
  return (
    <div style={{ position: 'relative', height: Math.max(1, totalRows * rowHeight - gap) }}>
      {rowIndexes.map((r) => {
        const rowStart = r * cols;
        const firstKey = items[rowStart] ? getKey(items[rowStart]!) : `row-${r}`;
        return (
          <div
            // key 用行首条目的 id 而不是行号：快速滚动时 React 组件随条目走，
            // 避免复用错误行的组件导致 BlobImage 的 lazy 状态串图。
            key={firstKey}
            style={{
              position: 'absolute',
              top: r * rowHeight,
              left: 0,
              right: 0,
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gap,
            }}
          >
            {items.slice(rowStart, Math.min(items.length, rowStart + cols)).map((item) => (
              <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** 图片卡片（方形，无文件名，保持相册密度）。 */
function ImageCard({
  image,
  store,
  blurred,
  onOpen,
  onActions,
  showName = false,
  selectMode = false,
  selected = false,
  onToggleSelect,
}: {
  image: ImageEntry;
  store: LibraryStore;
  blurred: boolean;
  onOpen: () => void;
  onActions: () => void;
  showName?: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const lp = useLongPress(onActions);
  return (
    <div
      className="m-gallery-item m-image-card relative overflow-hidden flex flex-col"
      role="button"
      tabIndex={0}
      aria-label={selectMode ? (selected ? `已选择 ${image.name}` : `选择 ${image.name}`) : image.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (selectMode) onToggleSelect?.(image.id);
          else onOpen();
        }
      }}
      onTouchStart={lp.onTouchStart}
      onTouchMove={lp.onTouchMove}
      onTouchEnd={lp.onTouchEnd}
      onTouchCancel={lp.onTouchCancel}
      onClick={() => {
        if (selectMode) {
          onToggleSelect?.(image.id);
          return;
        }
        if (lp.wasLongPress()) return;
        onOpen();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="relative w-full aspect-square overflow-hidden shrink-0">
        {lp.pressing && <div className="absolute inset-0 bg-black/25 pointer-events-none" aria-hidden="true" />}
        {selectMode && (
          <div
            className={"m-selection-indicator absolute top-1 right-1 w-5 h-5 flex items-center justify-center text-[10px] z-10 " +
              (selected ? 'bg-primary border-primary text-primary-content' : 'bg-black/40 border-white/70 text-white')}
            aria-hidden="true"
          >
            {selected ? '✓' : ''}
          </div>
        )}
        {/* VirtualGrid 已经限制了挂载窗口，卡片内不再叠加 IntersectionObserver。 */}
        <BlobImage
          store={store}
          fileRef={imageToFileRef(image)}
          alt={image.name}
            className="w-full h-full object-cover"
            thumbnail
            lazy={false}
            blur={blurred}
        />
      </div>
      {showName && (
        <div
          className="m-image-name shrink-0 truncate select-none"
          style={{ height: IMAGE_NAME_H }}
          aria-hidden="true"
        >
          {image.name}
        </div>
      )}
    </div>
  );
}

/** 列表视图行（缩略图 + 名称 + 尺寸）。 */
function ImageListRow({
  image,
  store,
  blurred,
  onOpen,
  onActions,
  selectMode = false,
  selected = false,
  onToggleSelect,
}: {
  image: ImageEntry;
  store: LibraryStore;
  blurred: boolean;
  onOpen: () => void;
  onActions: () => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const lp = useLongPress(onActions);
  const meta = [image.width && image.height ? `${image.width}×${image.height}` : '', image.size ? formatBytes(image.size) : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      className={"m-image-list-row flex items-center gap-3 " + (selectMode && selected ? 'is-selected' : '')}
      role="button"
      tabIndex={0}
      aria-label={selectMode ? (selected ? `已选择 ${image.name}` : `选择 ${image.name}`) : image.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (selectMode) onToggleSelect?.(image.id);
          else onOpen();
        }
      }}
      onTouchStart={lp.onTouchStart}
      onTouchMove={lp.onTouchMove}
      onTouchEnd={lp.onTouchEnd}
      onTouchCancel={lp.onTouchCancel}
      onClick={() => {
        if (selectMode) {
          onToggleSelect?.(image.id);
          return;
        }
        if (lp.wasLongPress()) return;
        onOpen();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="m-list-thumb relative w-14 h-14 overflow-hidden shrink-0">
        {selectMode && (
          <div
            className={"m-selection-indicator absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center text-[9px] z-10 " +
              (selected ? 'bg-primary border-primary text-primary-content' : 'bg-black/40 border-white/70 text-white')}
            aria-hidden="true"
          >
            {selected ? '✓' : ''}
          </div>
        )}
        <BlobImage
          store={store}
          fileRef={imageToFileRef(image)}
          alt={image.name}
           className="w-full h-full object-cover"
           thumbnail
           lazy
           blur={blurred}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="m-list-title truncate">{image.name}</div>
        {meta && <div className="m-list-meta tabular-nums truncate">{meta}</div>}
      </div>
    </div>
  );
}

/** 文件夹卡片（封面 + 名称 + 计数）。 */
function FolderCard({
  folder,
  coverImage,
  store,
  pinned,
  blurred,
  onOpen,
  onActions,
}: {
  folder: FolderNode;
  coverImage: ImageEntry | undefined;
  store: LibraryStore;
  pinned: boolean;
  blurred: boolean;
  onOpen: () => void;
  onActions: () => void;
}) {
  const lp = useLongPress(onActions);
  return (
    <div
      className="m-gallery-item m-folder-card relative overflow-hidden"
      role="button"
      tabIndex={0}
      aria-label={folder.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onTouchStart={lp.onTouchStart}
      onTouchMove={lp.onTouchMove}
      onTouchEnd={lp.onTouchEnd}
      onTouchCancel={lp.onTouchCancel}
      onClick={() => {
        if (!lp.wasLongPress()) onOpen();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {lp.pressing && <div className="absolute inset-0 bg-black/25 pointer-events-none" aria-hidden="true" />}
      <div className="m-folder-cover relative aspect-[16/10] overflow-hidden">
        {coverImage ? (
          <BlobImage
            store={store}
            fileRef={imageToFileRef(coverImage)}
            alt={folder.name}
             className="w-full h-full object-cover"
             thumbnail
             thumbnailSize={pinned ? COVER_THUMBNAIL_SIZE : undefined}
             lazy
             blur={blurred}
          />
        ) : (
          <div className="m-folder-placeholder w-full h-full flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-10 h-10" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
          </div>
        )}
        {pinned && (
          <span className="m-pin-badge absolute top-1.5 left-1.5"><MobileIcon name="📌" className="w-3.5 h-3.5" /></span>
        )}
      </div>
      <div className="m-folder-caption flex items-center justify-between gap-2" style={{ height: FOLDER_CAPTION_H }}>
        <span className="m-folder-title truncate">{folder.name}</span>
        <span className="m-folder-meta whitespace-nowrap tabular-nums">
          {folder.imageCount} 图 / {folder.childCount} 夹
        </span>
      </div>
    </div>
  );
}

function virtualWindowKey(
  scrollTop: number,
  sectionTop: number,
  viewportH: number,
  rowHeight: number,
  cols: number,
  itemCount: number,
): string {
  if (rowHeight <= 0 || viewportH <= 0 || cols <= 0 || itemCount <= 0) return 'empty';
  const totalRows = Math.ceil(itemCount / cols);
  const gs = Math.max(0, scrollTop - sectionTop);
  const first = Math.max(0, Math.floor(gs / rowHeight) - MOBILE_OVERSCAN_ROWS);
  const last = Math.min(totalRows, Math.ceil((gs + viewportH) / rowHeight) + MOBILE_OVERSCAN_ROWS);
  return `${first}:${last}`;
}

/** 文件夹列表行（封面 + 名称 + 递归图片/子目录计数）。 */
function FolderListRow({
  folder,
  coverImage,
  store,
  pinned,
  blurred,
  onOpen,
  onActions,
}: {
  folder: FolderNode;
  coverImage: ImageEntry | undefined;
  store: LibraryStore;
  pinned: boolean;
  blurred: boolean;
  onOpen: () => void;
  onActions: () => void;
}) {
  const lp = useLongPress(onActions);
  return (
    <div
      className="m-folder-list-row flex items-center gap-3"
      role="button"
      tabIndex={0}
      aria-label={folder.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onTouchStart={lp.onTouchStart}
      onTouchMove={lp.onTouchMove}
      onTouchEnd={lp.onTouchEnd}
      onTouchCancel={lp.onTouchCancel}
      onClick={() => {
        if (!lp.wasLongPress()) onOpen();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="m-list-thumb relative w-14 h-14 overflow-hidden shrink-0">
        {lp.pressing && <div className="absolute inset-0 bg-black/25 pointer-events-none z-10" aria-hidden="true" />}
        {coverImage ? (
          <BlobImage
            store={store}
            fileRef={imageToFileRef(coverImage)}
            alt={folder.name}
             className="w-full h-full object-cover"
             thumbnail
             thumbnailSize={pinned ? COVER_THUMBNAIL_SIZE : undefined}
             lazy
             blur={blurred}
          />
        ) : (
          <div className="m-folder-placeholder w-full h-full flex items-center justify-center">
            <MobileIcon name="📂" className="w-6 h-6" />
          </div>
        )}
        {pinned && <span className="m-list-pin absolute top-1 left-1"><MobileIcon name="📌" className="w-3 h-3" /></span>}
      </div>
      <div className="flex-1 min-w-0">
        <div className="m-list-title truncate">{folder.name}</div>
        <div className="m-list-meta tabular-nums truncate">
          {folder.imageCount} 张图片 · {folder.childCount} 个子文件夹
        </div>
      </div>
      <svg viewBox="0 0 24 24" className="m-list-chevron w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </div>
  );
}

function MobileToolsScreen({
  onBack,
  onOpenSettings,
  onImport,
  imageCount,
  importReport,
  lastManifest,
  organizing,
  onOrganize,
  onExport,
  onUndo,
  onShowReport,
}: ToolsScreenProps) {
  return (
    <div className="m-mine-screen fixed inset-0 flex flex-col" style={{ zIndex: Z_SETTINGS }}>
      <header className="m-context-header shrink-0" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="m-context-bar">
          <button className="m-icon-button" onClick={onBack} aria-label="返回图库">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <div className="m-context-title">
            <strong>工具</strong>
            <span>图库任务与维护</span>
          </div>
          <span className="w-11 h-11 shrink-0" aria-hidden="true" />
        </div>
      </header>
      <main className="m-mine-content flex-1 overflow-y-auto overscroll-contain">
        <section className="m-mine-hero">
          <span className="m-eyebrow">工作区</span>
          <h1>管理本地图库</h1>
          <p>导入、整理和导出都集中在这里，任务离开页面后仍可继续。</p>
        </section>
        <section className="m-mine-group">
          <h2 className="m-settings-group-title">图库操作</h2>
          <button className="m-mine-entry" onClick={onImport}>
            <span className="m-mine-entry-icon"><MobileIcon name="📁" className="w-5 h-5" /></span>
            <span className="m-mine-entry-copy">
              <strong>导入图包</strong>
              <span>从设备目录复制图片到 Kanitsu</span>
            </span>
            <svg viewBox="0 0 24 24" className="m-list-chevron w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          <button className="m-mine-entry" disabled={imageCount === 0} onClick={onOrganize}>
            <span className="m-mine-entry-icon"><MobileIcon name="🧹" className="w-5 h-5" /></span>
            <span className="m-mine-entry-copy">
              <strong>整理图库</strong>
              <span>按文件名规则重新分组图片</span>
            </span>
            <svg viewBox="0 0 24 24" className="m-list-chevron w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          <button className="m-mine-entry" disabled={imageCount === 0} onClick={onExport}>
            <span className="m-mine-entry-icon"><MobileIcon name="⬆️" className="w-5 h-5" /></span>
            <span className="m-mine-entry-copy">
              <strong>导出图库</strong>
              <span>将全部图包导出为 ZIP</span>
            </span>
            <svg viewBox="0 0 24 24" className="m-list-chevron w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </section>
        {(lastManifest || importReport) && (
          <section className="m-mine-group">
            <h2 className="m-settings-group-title">最近活动</h2>
            {lastManifest && (
              <button className="m-mine-entry" disabled={organizing} onClick={onUndo}>
                <span className="m-mine-entry-icon"><MobileIcon name="↩️" className="w-5 h-5" /></span>
                <span className="m-mine-entry-copy">
                  <strong>撤销上次整理</strong>
                  <span>恢复整理前的文件位置</span>
                </span>
                <svg viewBox="0 0 24 24" className="m-list-chevron w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            )}
            {importReport && (
              <button className="m-mine-entry" onClick={onShowReport}>
                <span className="m-mine-entry-icon"><MobileIcon name="📋" className="w-5 h-5" /></span>
                <span className="m-mine-entry-copy">
                  <strong>导入报告</strong>
                  <span>查看最近一次导入的跳过与失败文件</span>
                </span>
                <svg viewBox="0 0 24 24" className="m-list-chevron w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            )}
          </section>
        )}
        <section className="m-mine-group">
          <h2 className="m-settings-group-title">应用</h2>
          <button className="m-mine-entry" onClick={onOpenSettings}>
            <span className="m-mine-entry-icon"><MobileIcon name="⚙️" className="w-5 h-5" /></span>
            <span className="m-mine-entry-copy">
              <strong>设置</strong>
              <span>主题、缓存、整理规则与诊断</span>
            </span>
            <svg viewBox="0 0 24 24" className="m-list-chevron w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </section>
      </main>
    </div>
  );
}

/** 抽屉内的递归目录树。 */
function MobileFolderTree({
  snapshot,
  folderId,
  selectedFolderId,
  expandedFolders,
  onSelect,
  onToggle,
  depth,
}: {
  snapshot: LibrarySnapshot;
  folderId: string;
  selectedFolderId: string;
  expandedFolders: ReadonlySet<string>;
  onSelect: (folder: FolderNode) => void;
  onToggle: (folderId: string) => void;
  depth: number;
}) {
  const children = childrenOf(snapshot, folderId).sort((a, b) => a.name.localeCompare(b.name));
  if (children.length === 0 && depth === 0) return null;
  return (
    <div className="m-tree-list flex flex-col">
      {children.map((folder) => {
        const hasChildren = folder.childCount > 0;
        const expanded = expandedFolders.has(folder.id);
        const selected = folder.id === selectedFolderId;
        return (
          <div key={folder.id}>
            <div className={`m-tree-row ${selected ? 'is-selected' : ''}`} style={{ paddingLeft: depth * 16 + 4 }}>
              <button
                className="m-tree-toggle"
                disabled={!hasChildren}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(folder.id);
                }}
                aria-label={expanded ? '收起' : '展开'}
              >
                <svg
                  viewBox="0 0 12 12"
                  width="12"
                  height="12"
                  className={`transition-transform ${expanded ? 'rotate-90' : ''} ${hasChildren ? 'opacity-60' : 'opacity-0'}`}
                >
                  <path d="M3.5 2.2L8.5 6l-5 3.8z" fill="currentColor" />
                </svg>
              </button>
              <button className="m-tree-link" onClick={() => onSelect(folder)}>
                <span className="m-tree-title">{folder.name}</span>
                <span className="m-tree-count">{folder.imageCount}</span>
              </button>
            </div>
            {hasChildren && expanded && (
              <MobileFolderTree
                snapshot={snapshot}
                folderId={folder.id}
                selectedFolderId={selectedFolderId}
                expandedFolders={expandedFolders}
                onSelect={onSelect}
                onToggle={onToggle}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MobileApp({
  picker,
  store,
  index,
}: {
  picker: ImportSourcePicker;
  store: LibraryStore;
  index: PersistentIndex;
}) {
  useEffect(() => startThemeModeSync(), []);

  // ===== 数据状态 =====
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [viewerSessionId, setViewerSessionId] = useState(0);
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'success' | 'error' } | null>(null);
  const [importReport, setImportReport] = useState<ImportTask | null>(null);
  const [showReport, setShowReport] = useState(false);
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

  // ===== UI 层状态 =====
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sheet, setSheet] = useState<SheetModel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [coverPickerFolder, setCoverPickerFolder] = useState<FolderNode | null>(null);
  // 多选 / 批量操作
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [organizePreview, setOrganizePreview] = useState<{ folder: FolderNode; bindings: OrganizeBinding[] } | null>(null);
  const [organizeResult, setOrganizeResult] = useState<OrganizeResult | null>(null);
  const [lastManifest, setLastManifest] = useState<OrganizeManifest | null>(null);

  // ===== 任务进度 =====
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ scanned: number; copied: number; skipped: number } | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [organizeProgress, setOrganizeProgress] = useState<{ done: number; total: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 任务取消句柄：导入/导出用 token（原生 cancelTask），整理用 JS 侧标志。
  const importCancelTokenRef = useRef<string | null>(null);
  const exportCancelTokenRef = useRef<string | null>(null);
  const organizeCancelRef = useRef<{ cancelled: boolean } | null>(null);

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const selectedFolderIdRef = useRef(selectedFolderId);
  selectedFolderIdRef.current = selectedFolderId;
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;

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

  // ===== 启动加载 =====
  useEffect(() => {
    void (async () => {
      try {
        applySnapshot(await loadOrScan(store, index));
      } catch (err) {
        setToast({ text: `加载失败：${String(err)}`, kind: 'error' });
      }
    })();
  }, [store, index, applySnapshot]);

  const refresh = useCallback(async () => {
    const next = await rescanLibrary(store, index);
    applySnapshot(next);
    return next;
  }, [store, index, applySnapshot]);

  // toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const notify = useCallback((text: string, kind?: 'info' | 'success' | 'error') => {
    const detected = kind ?? (/失败|错误/.test(text) ? 'error' : /完成|成功|^已/.test(text) ? 'success' : 'info');
    setToast({ text, kind: detected });
  }, []);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
      notify('已刷新', 'success');
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
    if (!snapshot) return { folderCount: 0, imageCount: 0, bytes: 0 };
    const images = Object.values(snapshot.images);
    return {
      folderCount: Object.values(snapshot.folders).filter((folder) => folder.id !== snapshot.rootId).length,
      imageCount: images.length,
      bytes: images.reduce((total, image) => total + (image.size ?? 0), 0),
    };
  }, [snapshot]);

  const searchTerm = searchQuery.trim().toLowerCase();
  const folderImages = useMemo(() => {
    if (!snapshot) return [];
    let images = directImagesOf(snapshot, currentFolderId);
    if (searchTerm) images = images.filter((img) => img.name.toLowerCase().includes(searchTerm));
    if (sortMode !== 'default') {
      const sorted = [...images];
      const direction = sortDirection === 'asc' ? 1 : -1;
      if (sortMode === 'name') sorted.sort((a, b) => direction * a.name.localeCompare(b.name, 'zh-CN'));
      else if (sortMode === 'date') sorted.sort((a, b) => direction * ((a.mtime ?? 0) - (b.mtime ?? 0)));
      else sorted.sort((a, b) => direction * ((a.size ?? 0) - (b.size ?? 0)));
      return sorted;
    }
    return images;
  }, [snapshot, currentFolderId, searchTerm, sortMode, sortDirection]);

  const childFolders = useMemo(() => {
    if (!snapshot) return [];
    const folders = childrenOf(snapshot, currentFolderId);
    const filtered = searchTerm ? folders.filter((f) => f.name.toLowerCase().includes(searchTerm)) : folders;
    if (sortMode === 'default') return filtered;
    const direction = sortDirection === 'asc' ? 1 : -1;
    if (sortMode === 'name') return [...filtered].sort((a, b) => direction * a.name.localeCompare(b.name, 'zh-CN'));
    const stats = new Map<string, { bytes: number; latestModified: number }>();
    for (const folder of filtered) {
      const images = imagesOf(snapshot, folder.id);
      stats.set(folder.id, {
        bytes: images.reduce((sum, image) => sum + image.size, 0),
        latestModified: images.reduce((latest, image) => Math.max(latest, image.mtime), 0),
      });
    }
    return [...filtered].sort((a, b) => {
      const aStats = stats.get(a.id)!;
      const bStats = stats.get(b.id)!;
      return sortMode === 'size'
        ? direction * (aStats.bytes - bStats.bytes)
        : direction * (aStats.latestModified - bStats.latestModified);
    });
  }, [snapshot, currentFolderId, searchTerm, sortMode, sortDirection]);

  const childFolderCards = useMemo(() => {
    if (!snapshot) return [];
    return childFolders.map((child) => {
      const cover = pickCover(imagesOf(snapshot, child.id), { preferredId: pinnedCovers[child.id] });
      return { folder: child, coverImage: cover ? snapshot.images[cover.imageId] : undefined };
    });
  }, [snapshot, childFolders, pinnedCovers]);

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
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [snapshot, searchTerm]);
  const searchFolderCards = useMemo(() => {
    if (!snapshot) return [];
    return searchFolders.map((child) => {
      const cover = pickCover(imagesOf(snapshot, child.id), { preferredId: pinnedCovers[child.id] });
      return { folder: child, coverImage: cover ? snapshot.images[cover.imageId] : undefined };
    });
  }, [snapshot, searchFolders, pinnedCovers]);

  // 聚合视图：当前目录 + 所有子目录的图片（递归收集）。
  const aggregateImages = useMemo(() => {
    if (!snapshot) return [];
    const ids = new Set<string>();
    const collect = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const f of Object.values(snapshot.folders)) {
        if (f.parentId === id) collect(f.id);
      }
    };
    collect(currentFolderId);
    const out: ImageEntry[] = [];
    for (const id of ids) out.push(...directImagesOf(snapshot, id));
    const direction = sortDirection === 'asc' ? 1 : -1;
    if (sortMode === 'name') out.sort((a, b) => direction * a.name.localeCompare(b.name, 'zh-CN'));
    else if (sortMode === 'date') out.sort((a, b) => direction * ((a.mtime ?? 0) - (b.mtime ?? 0)));
    else if (sortMode === 'size') out.sort((a, b) => direction * ((a.size ?? 0) - (b.size ?? 0)));
    return out;
  }, [snapshot, currentFolderId, sortMode, sortDirection]);

  /** 实际显示的图片列表：搜索 > 聚合 > 当前目录。 */
  const displayImages = aggregate && !searching ? aggregateImages : folderImages;
  const viewerImages = searching ? searchImages : displayImages;
  const viewerIndex = viewerImageId ? viewerImages.findIndex((img) => img.id === viewerImageId) : -1;
  const viewerOpen = viewerImageId != null && viewerIndex >= 0;

  // ===== 返回键混合栈（folder 导航 + overlay 层）=====
  // 以 history.state 中的栈快照为唯一权威：目录导航使用 pushState，overlay
  // 使用 replaceState 写入当前快照，不制造额外的浏览器历史项。popstate
  // 按快照对账（差量关闭 overlay / 回退文件夹），不再用 consumedPops 计数器——
  // 它是快速连续返回 / 主动关闭与硬件返回交错时栈错乱的竞态根源。
  const stackRef = useRef<StackEntry[]>([]);

  const readStackSnapshot = useCallback((): StackEntry[] => {
    const s = window.history.state as { kanitsuStack?: unknown } | null;
    return Array.isArray(s?.kanitsuStack) ? (s.kanitsuStack as StackEntry[]) : [];
  }, []);

  const closeOverlayUI = useCallback((layer: OverlayLayer) => {
    switch (layer) {
      case 'drawer':
        setDrawerOpen(false);
        break;
      case 'sheet':
        setSheet(null);
        break;
      case 'viewer':
        setViewerImageId(null);
        break;
      case 'settings':
        setShowSettings(false);
        break;
      case 'tools':
        setShowTools(false);
        break;
      case 'organize':
        setOrganizePreview(null);
        break;
      case 'cover':
        setCoverPickerFolder(null);
        break;
      case 'dialog':
        setDeleteTarget(null);
        setPromptState(null);
        break;
      case 'report':
        setShowReport(false);
        break;
      case 'search':
        setSearchActive(false);
        setSearchQuery('');
        setSearchInput('');
        break;
    }
  }, []);

  const entryEq = (a: StackEntry, b: StackEntry): boolean => {
    if (a.type === 'folder' && b.type === 'folder') return a.folderId === b.folderId;
    if (a.type === 'overlay' && b.type === 'overlay') return a.layer === b.layer;
    return false;
  };

  useEffect(() => {
    const onPop = () => {
      const target = readStackSnapshot();
      const current = stackRef.current;
      // 快照与当前一致：这是主动关闭触发的 back()，已同步处理过，直接忽略。
      if (target.length === current.length && target.every((e, i) => entryEq(e, current[i]!))) return;
      // 目标栈是当前栈去掉若干顶层后的前缀：逐层关闭差异 overlay，并回退文件夹。
      let i = 0;
      while (i < current.length && i < target.length && entryEq(current[i]!, target[i]!)) i++;
      stackRef.current = target;
      for (let k = i; k < current.length; k++) {
        const e = current[k]!;
        if (e.type === 'overlay') closeOverlayUI(e.layer);
      }
      const topFolder = [...target].reverse().find((e): e is { type: 'folder'; folderId: string } => e.type === 'folder');
      const folderId = topFolder ? topFolder.folderId : snapshotRef.current?.rootId ?? '';
      selectedFolderIdRef.current = folderId;
      setSelectedFolderId(folderId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [closeOverlayUI, readStackSnapshot]);

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
      const stack = stackRef.current;
      const idx = stack
        .map((e, i) => (e.type === 'overlay' && e.layer === layer ? i : -1))
        .filter((i) => i >= 0)
        .pop();
      if (idx == null) {
        closeOverlayUI(layer);
        return;
      }
      const next = stack.slice(0, idx);
      stackRef.current = next;
      for (let k = idx; k < stack.length; k++) {
        const e = stack[k]!;
        if (e.type === 'overlay') closeOverlayUI(e.layer);
      }
      window.history.replaceState({ kanitsuStack: next }, '');
    },
    [closeOverlayUI],
  );

  // Android hardware back is routed here by MainActivity. Keeping the event
  // cancelable lets the native layer distinguish "close the current UI layer"
  // from "leave the app" without duplicating the navigation stack in Java.
  useEffect(() => {
    const onAndroidBack = (event: Event) => {
      // 多选不是 history 层：先退出多选，避免硬件返回把当前图包直接退回根目录。
      if (selectModeRef.current) {
        event.preventDefault();
        setSelectMode(false);
        setSelectedIds(new Set());
        return;
      }
      const top = stackRef.current[stackRef.current.length - 1];
      if (top?.type === 'overlay') {
        event.preventDefault();
        closeOverlay(top.layer);
        return;
      }
      if (stackRef.current.length === 0) return;
      event.preventDefault();
      window.history.back();
    };
    window.addEventListener('kanitsu:android-back', onAndroidBack);
    return () => window.removeEventListener('kanitsu:android-back', onAndroidBack);
  }, [closeOverlay]);

  /**
   * Replace an open overlay in-place. This avoids racing history.go() when a
   * drawer action opens settings or a folder in the same tap.
   */
  const replaceOverlay = useCallback(
    (from: OverlayLayer, to: OverlayLayer): boolean => {
      const stack = stackRef.current;
      const idx = stack
        .map((entry, index) => (entry.type === 'overlay' && entry.layer === from ? index : -1))
        .filter((index) => index >= 0)
        .pop();
      if (idx == null) return false;

      const next = [...stack.slice(0, idx), { type: 'overlay' as const, layer: to }];
      stackRef.current = next;
      for (let k = idx; k < stack.length; k++) {
        const entry = stack[k]!;
        if (entry.type === 'overlay') closeOverlayUI(entry.layer);
      }
      window.history.replaceState({ kanitsuStack: next }, '');
      return true;
    },
    [closeOverlayUI],
  );

  const navigateToFolder = useCallback(
    (folderId: string) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const target = folderId || snap.rootId;
      // 使用同步 ref 而不是 render 闭包，防止一次触摸被 WebView 合成为两次 click
      // 时连续 push 两个相同目录历史项。
      if (target === (selectedFolderIdRef.current || snap.rootId)) return;
      const next: StackEntry[] = [...stackRef.current, { type: 'folder', folderId: target }];
      stackRef.current = next;
      window.history.pushState({ kanitsuStack: next }, '');
      selectedFolderIdRef.current = target;
      setSelectedFolderId(target);
      const folder = snap.folders[target];
      if (folder && folder.childCount > 0) {
        setExpandedFolders((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
      }
      setSearchQuery('');
      setSearchInput('');
      setSearchActive(false);
    },
    [],
  );

  const navigateFromDrawer = useCallback(
    (folderId: string) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const target = folderId || snap.rootId;
      const stack = stackRef.current;
      const idx = stack
        .map((entry, index) => (entry.type === 'overlay' && entry.layer === 'drawer' ? index : -1))
        .filter((index) => index >= 0)
        .pop();

      if (idx == null) {
        setDrawerOpen(false);
        navigateToFolder(target);
        return;
      }

      // 抽屉本身不占浏览器历史项：先原地移除抽屉，再按普通目录导航 push。
      // 不能直接把 drawer replace 成 folder，否则该目录没有可返回的前一项。
      const base = stack.slice(0, idx);
      stackRef.current = base;
      closeOverlayUI('drawer');
      window.history.replaceState({ kanitsuStack: base }, '');
      navigateToFolder(target);
    },
    [closeOverlayUI, navigateToFolder],
  );

  const openSettings = useCallback(() => {
    setShowSettings(true);
    if (!replaceOverlay('drawer', 'settings')) openOverlay('settings');
  }, [openOverlay, replaceOverlay]);

  const openTools = useCallback(() => {
    setShowTools(true);
    openOverlay('tools');
  }, [openOverlay]);

  const goUp = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap) return;
    const folder = snap.folders[selectedFolderIdRef.current || snap.rootId];
    const target = folder?.parentId ?? snap.rootId;
    const stack = stackRef.current;
    const top = stack[stack.length - 1];
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
  }, []);

  // ===== 滚动 + 虚拟化度量 =====
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const scrollSaveFrameRef = useRef<number | null>(null);
  const scrollPreloadResumeTimerRef = useRef<number | null>(null);
  const virtualWindowKeyRef = useRef('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [contentW, setContentW] = useState(0);
  const folderSectionRef = useRef<HTMLElement>(null);
  const imageSectionRef = useRef<HTMLElement>(null);
  const [sectionTops, setSectionTops] = useState({ folder: 0, image: 0 });

  const imageCardSize = contentW > 0 ? (contentW - IMAGE_GAP * (IMAGE_COLS - 1)) / IMAGE_COLS : 0;
  const imageRowHeight = imageCardSize + IMAGE_GAP + (showFileNames ? IMAGE_NAME_H : 0);
  // 只有一个图包时使用整行，避免根页面留下半屏空白；多个图包仍保持紧凑两列。
  const folderCols = childFolderCards.length === 1 ? 1 : FOLDER_COLS;
  const folderCardWidth = contentW > 0 ? (contentW - FOLDER_GAP * (folderCols - 1)) / folderCols : 0;
  const folderRowHeight = folderCardWidth > 0 ? folderCardWidth * 0.625 + FOLDER_CAPTION_H + FOLDER_GAP : 0;
  const searchFolderCols = searchFolderCards.length === 1 ? 1 : FOLDER_COLS;
  const searchFolderCardWidth = contentW > 0 ? (contentW - FOLDER_GAP * (searchFolderCols - 1)) / searchFolderCols : 0;
  const searchFolderRowHeight =
    searchFolderCardWidth > 0 ? searchFolderCardWidth * 0.625 + FOLDER_CAPTION_H + FOLDER_GAP : 0;

  const onMainScroll = useCallback(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    // 快速滚动时只保留可见/方向预取，暂停当前目录和全库预热，避免后台
    // 请求占满桥接与原生解码时隙。滚动停止一小段时间后再恢复。
    setThumbnailPreloadPaused(true);
    if (scrollPreloadResumeTimerRef.current != null) {
      window.clearTimeout(scrollPreloadResumeTimerRef.current);
    }
    scrollPreloadResumeTimerRef.current = window.setTimeout(() => {
      scrollPreloadResumeTimerRef.current = null;
      setThumbnailPreloadPaused(false);
    }, MOBILE_SCROLL_PRELOAD_RESUME_MS);
    const st = el.scrollTop;
    // 滚动位置本身不需要驱动 React；只有虚拟行窗口变化时才更新，避免
    // 高刷设备每个滚动事件都重渲染整页。
    const folderKey = searching
      ? virtualWindowKey(st, sectionTops.folder, viewportH, searchFolderRowHeight, searchFolderCols, searchFolderCards.length)
      : virtualWindowKey(st, sectionTops.folder, viewportH, folderRowHeight, folderCols, childFolderCards.length);
    const imageKey = virtualWindowKey(
      st,
      sectionTops.image,
      viewportH,
      imageRowHeight,
      IMAGE_COLS,
      searching ? searchImages.length : displayImages.length,
    );
    const nextWindowKey = `${searching ? 'search' : 'library'}:${folderKey}|${imageKey}`;
    if (virtualWindowKeyRef.current !== nextWindowKey) {
      virtualWindowKeyRef.current = nextWindowKey;
      setScrollTop(st);
    }
    if (scrollSaveFrameRef.current != null) return;
    scrollSaveFrameRef.current = requestAnimationFrame(() => {
      scrollSaveFrameRef.current = null;
      const node = mainScrollRef.current;
      if (!node) return;
      scrollPositionsRef.current.set(currentFolderId, node.scrollTop);
    });
  }, [
    childFolderCards.length,
    displayImages.length,
    folderCols,
    folderRowHeight,
    imageRowHeight,
    searchFolderCards.length,
    searchFolderCols,
    searchFolderRowHeight,
    searchImages.length,
    searching,
    sectionTops,
    viewportH,
    currentFolderId,
  ]);

  useEffect(() => {
    return () => {
      if (scrollPreloadResumeTimerRef.current != null) {
        window.clearTimeout(scrollPreloadResumeTimerRef.current);
        scrollPreloadResumeTimerRef.current = null;
      }
      setThumbnailPreloadPaused(false);
    };
  }, []);

  useEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    const measure = () => {
      setViewportH(el.clientHeight);
      setContentW(el.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 度量两个 section 相对内容顶部的偏移
  useLayoutEffect(() => {
    const main = mainScrollRef.current;
    if (!main) return;
    const top = (el: HTMLElement | null) =>
      el ? el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop : 0;
    setSectionTops({ folder: top(folderSectionRef.current), image: top(imageSectionRef.current) });
  }, [
    childFolderCards.length,
    folderImages.length,
    searchFolderCards.length,
    searchImages.length,
    searchTerm,
    searching,
    currentFolderId,
    contentW,
    viewMode,
    showFileNames,
    aggregate,
  ]);

  // 切换目录后恢复滚动位置
  useLayoutEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    el.scrollTop = scrollPositionsRef.current.get(currentFolderId) ?? 0;
    setScrollTop(el.scrollTop);
  }, [currentFolderId, snapshot]);

  // ===== 缩略图预取（与桌面同优先级策略）=====
  useEffect(() => {
    if (!snapshot || folderImages.length === 0 || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const files = folderImages.map(imageToFileRef);
    preloadThumbnails(store, files, { priority: THUMB_PRIORITY_CURRENT_DIR, concurrency: 4, shouldStop: () => token.cancelled });
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, currentFolderId, folderImages, store]);

  useEffect(() => {
    if (!snapshot || childFolderCards.length === 0 || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const covers: FileRef[] = [];
    const pinnedCoverFiles: FileRef[] = [];
    for (const card of childFolderCards.slice(0, 16)) {
      if (card.coverImage) {
        covers.push(imageToFileRef(card.coverImage));
        if (pinnedCovers[card.folder.id] === card.coverImage.id) pinnedCoverFiles.push(imageToFileRef(card.coverImage));
      }
      for (const img of imagesOf(snapshot, card.folder.id).slice(0, 8)) covers.push(imageToFileRef(img));
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
  }, [snapshot, childFolderCards, pinnedCovers, store]);

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

  // 滚动方向预取：下一屏图片优先生成（带节流：快速来回滚动只在时间窗内触发一次，
  // 避免方向一变就重新提交整屏任务，重复取消/重排造成无谓的 IPC 与解码压力）。
  const lastScrollTopRef = useRef(0);
  const lastDirPrefetchAtRef = useRef(0);
  useEffect(() => {
    if (folderImages.length === 0 || !isPrefetchEnabled() || imageRowHeight <= 0 || viewportH <= 0) return;
    const st = scrollTop;
    const prev = lastScrollTopRef.current;
    const dir = st > prev ? 'down' : st < prev ? 'up' : null;
    lastScrollTopRef.current = st;
    if (!dir) return;
    // 节流：距上次方向预取 <150ms 则跳过（下一帧滚动到位后自然恢复触发）。
    const now = Date.now();
    if (now - lastDirPrefetchAtRef.current < 150) return;
    lastDirPrefetchAtRef.current = now;
    const gs = Math.max(0, st - sectionTops.image);
    const screenRows = Math.max(1, Math.ceil(viewportH / imageRowHeight));
    const firstRow = Math.floor(gs / imageRowHeight);
    const lastRow = Math.ceil((gs + viewportH) / imageRowHeight);
    const from = dir === 'down' ? lastRow : firstRow - screenRows;
    const to = dir === 'down' ? lastRow + screenRows : firstRow;
    const start = Math.max(0, from * IMAGE_COLS);
    const end = Math.min(folderImages.length, Math.max(0, to) * IMAGE_COLS);
    if (end <= start) return;
    const token = { cancelled: false };
    preloadThumbnails(store, folderImages.slice(start, end).map(imageToFileRef), {
      priority: THUMB_PRIORITY_DIRECTIONAL,
      recheck: true,
      shouldStop: () => token.cancelled,
    });
    return () => {
      token.cancelled = true;
    };
  }, [scrollTop, viewportH, folderImages, store, imageRowHeight, sectionTops.image]);

  // ===== 业务操作 =====
  const handleImport = useCallback(async () => {
    if (importing) return;
    const token = `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    importCancelTokenRef.current = token;
    setImporting(true);
    setImportProgress({ scanned: 0, copied: 0, skipped: 0 });
    try {
      const task = await importFolder(picker, store, {
        cancelToken: token,
        onProgress: (p) => setImportProgress({ scanned: p.scanned, copied: p.copied, skipped: p.skipped }),
      });
      if (task.status === 'canceled') {
        notify(`导入已取消：已复制 ${task.copiedImageCount} 张`, 'info');
        setImportReport(task);
        await refresh();
        return;
      }
      setImportReport(task);
      const next = await refresh();
      const topFolder = Object.values(next.folders).find((f) => f.parentId === next.rootId && f.name === task.targetTopFolder);
      if (topFolder) {
        // 工具页是全屏 overlay：先关层再跳转，否则图包条目会压在 overlay 之上，
        // 关闭工具页时被 slice 一并丢弃，返回栈与当前目录脱节（硬件返回键会直接退出应用）。
        closeOverlay('tools');
        navigateToFolder(topFolder.id);
      }
      notify(
        task.skippedCount > 0
          ? `导入完成：复制 ${task.copiedImageCount} 张，跳过 ${task.skippedCount} 张`
          : `导入完成：复制 ${task.copiedImageCount} 张`,
      );
    } catch (err) {
      const msg = String(err);
      if (!/取消/.test(msg)) notify(`导入失败：${msg}`, 'error');
    } finally {
      importCancelTokenRef.current = null;
      setImporting(false);
      setImportProgress(null);
    }
  }, [importing, picker, store, refresh, navigateToFolder, notify, closeOverlay]);

  const openOrganizeFor = useCallback(
    (folder: FolderNode) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const bindings = organizeByFolder(imagesOf(snap, folder.id), { customRules });
      setOrganizePreview({ folder, bindings });
      openOverlay('organize');
    },
    [customRules, openOverlay],
  );

  const handleApplyOrganize = useCallback(async () => {
    const preview = organizePreview;
    const snap = snapshotRef.current;
    if (!preview || !snap) return;
    closeOverlay('organize');
    const flag = { cancelled: false };
    organizeCancelRef.current = flag;
    setOrganizing(true);
    setOrganizeProgress({ done: 0, total: preview.bindings.length });
    try {
      const result = await applyOrganize(store, snap, preview.folder.relPath, preview.bindings, {
        onProgress: (done, total) => setOrganizeProgress({ done, total }),
        shouldCancel: () => flag.cancelled,
      });
      setOrganizeResult(result);
      setLastManifest(result.manifest);
      await refresh();
      notify(
        result.canceled
          ? `整理已取消：已移动 ${result.appliedCount} 个文件`
          : result.conflicts.length > 0
            ? `整理完成：移动 ${result.appliedCount} 个文件，${result.conflicts.length} 个冲突`
            : `整理完成：移动 ${result.appliedCount} 个文件`,
      );
    } catch (err) {
      notify(`整理失败：${String(err)}`, 'error');
    } finally {
      organizeCancelRef.current = null;
      setOrganizing(false);
      setOrganizeProgress(null);
    }
  }, [organizePreview, store, refresh, notify, closeOverlay]);

  const handleUndoOrganize = useCallback(async () => {
    if (!lastManifest || organizing) return;
    setOrganizing(true);
    try {
      const result = await undoOrganize(store, lastManifest);
      setLastManifest(null);
      setOrganizeResult(null);
      await refresh();
      notify(
        result.errors.length > 0
          ? `撤销完成：已还原 ${result.undone} 项，${result.errors.length} 项失败`
          : `撤销完成：已还原 ${result.undone} 项`,
      );
    } catch (err) {
      notify(`撤销失败：${String(err)}`, 'error');
    } finally {
      setOrganizing(false);
    }
  }, [lastManifest, organizing, store, refresh, notify]);

  const handleExport = useCallback(
    async (folder: FolderNode) => {
      if (exporting) return;
      const token = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      exportCancelTokenRef.current = token;
      setExporting(true);
      setExportProgress({ done: 0, total: 0 });
      try {
        const result = await store.zipLibrary(folder.relPath, (done, total) => setExportProgress({ done, total }), token);
        if (result.canceled) {
          notify(`导出已取消：已写入 ${result.exportedCount} 张`, 'info');
        } else {
          notify(`已导出 ${result.exportedCount} 张图片`, 'success');
        }
      } catch (err) {
        const msg = String(err);
        if (!/取消/.test(msg)) notify(`导出失败：${msg}`, 'error');
      } finally {
        exportCancelTokenRef.current = null;
        setExporting(false);
        setExportProgress(null);
      }
    },
    [exporting, store, notify],
  );

  const cancelImport = useCallback(() => {
    const token = importCancelTokenRef.current;
    if (token) void store.cancelTask?.(token);
  }, [store]);

  const cancelExport = useCallback(() => {
    const token = exportCancelTokenRef.current;
    if (token) void store.cancelTask?.(token);
  }, [store]);

  const cancelOrganize = useCallback(() => {
    if (organizeCancelRef.current) organizeCancelRef.current.cancelled = true;
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
    setSelectedIds(new Set(displayImages.map((img) => img.id)));
  }, [displayImages]);

  const handleBatchDelete = useCallback(async () => {
    const targets = displayImages.filter((img) => selectedIds.has(img.id));
    if (targets.length === 0) return;
    if (!window.confirm(`删除选中的 ${targets.length} 张图片？`)) return;
    let ok = 0;
    for (const img of targets) {
      try {
        await deleteImage(store, img);
        ok++;
      } catch {
        // 单个失败继续
      }
    }
    await refresh();
    exitSelectMode();
    notify(`已删除 ${ok} 张图片`, 'success');
  }, [displayImages, selectedIds, store, refresh, exitSelectMode, notify]);


  const handleDeleteConfirm = useCallback(async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    closeOverlay('dialog');
    if (!target) return;
    try {
      if (target.kind === 'image') {
        await deleteImage(store, target.image);
        await refresh();
        notify(`已删除图片「${target.image.name}」`, 'success');
      } else {
        const parentId = target.folder.parentId;
        await deleteLibraryFolder(store, target.folder.relPath);
        await refresh();
        if (currentFolderId === target.folder.id && parentId) setSelectedFolderId(parentId);
        notify(`已删除相册「${target.folder.name}」`, 'success');
      }
    } catch (err) {
      notify(`删除失败：${String(err)}`, 'error');
    }
  }, [deleteTarget, store, refresh, notify, closeOverlay, currentFolderId]);

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
          const targets = displayImages.filter((img) => selectedIds.has(img.id));
          let moved = 0;
          for (const img of targets) {
            try {
              await store.move({ id: img.fileRefId ?? img.id, name: img.name, kind: 'file' }, created, img.name);
              moved++;
            } catch {
              // 单个移动失败继续
            }
          }
          await refresh();
          exitSelectMode();
          notify(`已移动 ${moved} 张到「${value}」`, 'success');
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
    [promptState, store, refresh, notify, closeOverlay, navigateToFolder, selectedFolder, displayImages, selectedIds, exitSelectMode],
  );

  const toggleImageBlur = useCallback(
    (image: ImageEntry) => {
      setBlurredImages((prev) => {
        const next = new Set(prev);
        if (next.has(image.relPath)) next.delete(image.relPath);
        else next.add(image.relPath);
        saveBlurredImages(next);
        return next;
      });
    },
    [],
  );

  const toggleFolderBlur = useCallback(
    (folder: FolderNode) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const images = imagesOf(snap, folder.id);
      if (images.length === 0) return;
      const allBlurred = images.every((img) => blurredImages.has(img.relPath));
      setBlurredImages((prev) => {
        const next = new Set(prev);
        for (const img of images) {
          if (allBlurred) next.delete(img.relPath);
          else next.add(img.relPath);
        }
        saveBlurredImages(next);
        return next;
      });
      notify(allBlurred ? `已取消「${folder.name}」的隐私预览` : `已为「${folder.name}」全部图片开启隐私预览`, 'success');
    },
    [blurredImages, notify],
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
      notify(imageId ? `已将「${label ?? '该图片'}」设为封面` : '已取消固定封面', 'success');
    },
    [notify],
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
      const pinned = pinnedCovers[image.folderId] === image.id;
      const actions: SheetAction[] = [
        ...(!fromViewer
          ? [{ label: '查看', icon: '👁', onSelect: () => openViewer(image) }]
          : []),
        {
          label: blurred ? '取消隐私预览' : '设为隐私预览',
          icon: blurred ? '🙈' : '🕶',
          onSelect: () => toggleImageBlur(image),
        },
        {
          label: pinned ? '取消固定封面' : '设为相册封面',
          icon: '📌',
          onSelect: () => pinCover(image.folderId, pinned ? null : image.id, image.name),
        },
        { label: '重命名', icon: '✏️', onSelect: () => openPrompt({ kind: 'rename-image', image }) },
        { label: '复制路径', icon: '🔗', onSelect: () => void copyText(image.relPath) },
        { label: '删除', icon: '🗑', danger: true, onSelect: () => openDelete({ kind: 'image', image }) },
      ];
      setSheet({ title: image.name, subtitle: image.relPath, actions });
      openOverlay('sheet');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blurredImages, pinnedCovers, toggleImageBlur, pinCover, copyText, openOverlay],
  );

  const openFolderActions = useCallback(
    (folder: FolderNode) => {
      const snap = snapshotRef.current;
      const images = snap ? imagesOf(snap, folder.id) : [];
      const allBlurred = images.length > 0 && images.every((img) => blurredImages.has(img.relPath));
      const isRootFolder = !folder.relPath;
      const actions: SheetAction[] = [
        { label: '打开', icon: '📂', onSelect: () => navigateToFolder(folder.id) },
        { label: '新建子文件夹', icon: '📁', onSelect: () => openPrompt({ kind: 'create-folder', folder }) },
        ...(!isRootFolder ? [{ label: '重命名', icon: '✏️', onSelect: () => openPrompt({ kind: 'rename-folder', folder }) }] : []),
        {
          label: allBlurred ? '取消隐私预览（含子文件夹）' : '设为隐私预览（含子文件夹）',
          icon: allBlurred ? '🙈' : '🕶',
          disabled: images.length === 0,
          onSelect: () => toggleFolderBlur(folder),
        },
        { label: '设置封面…', icon: '🖼', disabled: images.length === 0, onSelect: () => openCoverPicker(folder) },
        { label: '整理（按规则分组）', icon: '🧹', disabled: images.length === 0, onSelect: () => openOrganizeFor(folder) },
        { label: '导出 ZIP', icon: '📦', disabled: images.length === 0, onSelect: () => void handleExport(folder) },
        { label: '复制路径', icon: '🔗', onSelect: () => void copyText(folder.relPath || '（根目录）') },
        ...(!isRootFolder
          ? [{ label: '删除相册', icon: '🗑', danger: true, onSelect: () => openDelete({ kind: 'folder', folder }) }]
          : []),
      ];
      setSheet({ title: folder.name || '全部相册', subtitle: folder.relPath || undefined, actions });
      openOverlay('sheet');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blurredImages, navigateToFolder, toggleFolderBlur, openOrganizeFor, handleExport, copyText, openOverlay],
  );

  // 排序方式选择器（替代原生 select 弹层，复用底部动作面板）。
  const openSortSheet = useCallback(() => {
    const actions: SheetAction[] = (Object.keys(SORT_MODE_LABELS) as SortMode[]).map((mode) => ({
      label: SORT_MODE_LABELS[mode],
      checked: sortMode === mode,
      onSelect: () => {
        setSortMode(mode);
        if (mode === 'name') setSortDirection('asc');
        else if (mode === 'date' || mode === 'size') setSortDirection('desc');
      },
    }));
    setSheet({ title: '排序方式', actions });
    openOverlay('sheet');
  }, [sortMode, openOverlay]);

  // ===== 打开各 UI 层（history 栈配对）=====
  const openViewer = useCallback(
    (image: ImageEntry) => {
      setViewerImageId(image.id);
      // Force a new viewer tree for every open so WebView cannot reuse the
      // previous session's decoded image or compositor layer.
      setViewerSessionId((id) => id + 1);
      openOverlay('viewer');
    },
    [openOverlay],
  );

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    openOverlay('drawer');
  }, [openOverlay]);

  const openPrompt = useCallback(
    (prompt: PromptState) => {
      setPromptState(prompt);
      openOverlay('dialog');
    },
    [openOverlay],
  );

  const handleBatchMove = useCallback(() => {
    const targets = displayImages.filter((img) => selectedIds.has(img.id));
    if (targets.length === 0) return;
    openPrompt({ kind: 'batch-move', count: targets.length });
  }, [displayImages, selectedIds, openPrompt]);

  const openDelete = useCallback(
    (target: DeleteTarget) => {
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
    openOverlay('search');
  }, [openOverlay]);

  const closeSearch = useCallback(() => {
    closeOverlay('search');
  }, [closeOverlay]);

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

  // ===== 渲染 =====
  const title = searchActive ? '' : selectedFolder?.name ?? '';
  const subtitle = selectedFolder
    ? `${selectedFolder.directImageCount} 图片 · ${selectedFolder.childCount} 子目录`
    : '';

  return (
    <div className="mobile-studio m-app-shell fixed inset-0 flex flex-col overflow-hidden">
      {(searchActive || selectMode || !isRoot) && (
        <header
          className="m-context-header shrink-0 z-20"
          style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        >
          {searchActive ? (
            <div className="m-context-bar">
              <button className="m-icon-button" onClick={closeSearch} aria-label="关闭搜索">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <label className="m-search-field flex-1">
                <MobileIcon name="🔍" className="w-[18px] h-[18px]" />
                <input
                  autoFocus
                  placeholder="搜索图包或文件名"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
                {searchInput && (
                  <button className="m-search-clear" onClick={() => setSearchInput('')} aria-label="清空">
                    ✕
                  </button>
                )}
              </label>
            </div>
          ) : selectMode ? (
            <div className="m-context-bar">
              <button className="m-text-button is-accent" onClick={exitSelectMode} aria-label="完成多选">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
                <span>完成</span>
              </button>
              <div className="m-context-title">
                <strong>已选 {selectedIds.size} 张</strong>
                <span>{selectedIds.size > 0 ? '点击图片可取消选择' : '点击图片选择'}</span>
              </div>
              <button className="m-text-button is-accent" onClick={handleSelectAll} aria-label="全选">
                全选
              </button>
            </div>
          ) : (
            <div className="m-context-bar">
              <button className="m-icon-button" onClick={goUp} aria-label="返回上级">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <div className="m-context-title">
                <strong>{title}</strong>
                {subtitle && <span>{subtitle}</span>}
              </div>
              <button className="m-icon-button" onClick={openSearch} aria-label="搜索">
                <MobileIcon name="🔍" className="w-5 h-5" />
              </button>
              <button
                className={`m-icon-button m-refresh-button ${refreshing ? 'is-loading' : ''}`}
                disabled={refreshing}
                onClick={() => void handleRefresh()}
                aria-label="刷新当前目录"
              >
                <MobileIcon name="🔄" className="w-5 h-5" />
              </button>
            </div>
          )}
        </header>
      )}

      {/* 主内容 */}
      <main
        ref={mainScrollRef}
        onScroll={onMainScroll}
        className={`m-library-scroll flex-1 overflow-y-auto overscroll-contain relative ${isRoot && !searchActive && !selectMode ? 'is-root' : ''}`}
      >
        {snapshot && isRoot && !searchActive && !selectMode && (
          <section className="m-library-intro">
            <div className="m-eyebrow-row">
              <span className="m-eyebrow">本地图书馆</span>
              <div className="m-library-head-actions">
                <button
                  className={`m-mini-icon-button m-refresh-button ${refreshing ? 'is-loading' : ''}`}
                  disabled={refreshing}
                  onClick={() => void handleRefresh()}
                  aria-label="刷新图库"
                >
                  <MobileIcon name="🔄" className="w-4 h-4" />
                </button>
                <button className="m-index-state" onClick={openDrawer}>
                  查看目录
                </button>
              </div>
            </div>
            <h1>全部图包</h1>
            <div className="m-library-stats">
              <span>{rootFolder?.childCount ?? 0} 个图包</span>
              <i />
              <span>{libraryStats.imageCount.toLocaleString('zh-CN')} 张图片</span>
              <i />
              <span>{formatBytes(libraryStats.bytes)}</span>
            </div>
            <div className="m-library-tools">
              <button className="m-search-launch" onClick={openSearch}>
                <MobileIcon name="🔍" className="w-[18px] h-[18px]" />
                <span>搜索图包或文件名</span>
                <small>本地</small>
              </button>
            </div>
            {childFolders.length === 0 && (
              <button className="m-import-launch" onClick={() => void handleImport()}>
                <span className="m-import-launch-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </span>
                <span className="m-import-launch-copy">
                  <strong>导入图包</strong>
                  <small>从设备选择文件夹，自动建立本地图库</small>
                </span>
                <svg viewBox="0 0 24 24" className="m-import-launch-arrow" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            )}
          </section>
        )}

        {snapshot && !isRoot && !searchActive && !selectMode && (lastManifest || importReport) && (
          <div className={`m-recent-actions ${isRoot ? 'is-root' : ''}`}>
            {lastManifest && (
              <button className="m-recent-action" disabled={organizing} onClick={() => void handleUndoOrganize()}>
                <MobileIcon name="↩️" className="w-4 h-4" />
                <span>撤销上次整理</span>
              </button>
            )}
            {importReport && (
              <button
                className="m-recent-action"
                onClick={() => {
                  setShowReport(true);
                  openOverlay('report');
                }}
              >
                <MobileIcon name="📋" className="w-4 h-4" />
                <span>查看导入报告</span>
              </button>
            )}
          </div>
        )}

        {!snapshot ? (
          <div className="m-loading-state">
            <span className="m-progress-spinner" aria-label="正在载入图库" />
          </div>
        ) : searching ? (
          searchFolders.length === 0 && searchImages.length === 0 ? (
            <div className="m-empty-state">
              <div>
                <span className="m-empty-icon"><MobileIcon name="🔍" className="w-6 h-6" /></span>
                <div className="m-empty-title">未找到匹配项</div>
                <div className="m-empty-copy">没有与「{searchQuery}」匹配的文件夹或图片</div>
              </div>
            </div>
          ) : (
            <div className="m-content-pad">
              {searchFolders.length > 0 && (
                <section ref={folderSectionRef} className="m-section">
                  <h3 className="m-section-label">
                    匹配的文件夹 <span className="tabular-nums">{searchFolders.length}</span>
                  </h3>
                  {viewMode === 'list' ? (
                    <div className="flex flex-col gap-1 px-0.5 pb-2">
                      {searchFolderCards.map((card) => (
                        <FolderListRow
                          key={card.folder.id}
                          folder={card.folder}
                          coverImage={card.coverImage}
                          store={store}
                          pinned={pinnedCovers[card.folder.id] != null}
                          blurred={card.coverImage ? isImageBlurred(card.coverImage.relPath, blurredImages) : false}
                          onOpen={() => navigateToFolder(card.folder.id)}
                          onActions={() => openFolderActions(card.folder)}
                        />
                      ))}
                    </div>
                  ) : (
                    <VirtualGrid
                      items={searchFolderCards}
                      cols={searchFolderCols}
                      rowHeight={searchFolderRowHeight}
                      gap={FOLDER_GAP}
                      scrollTop={scrollTop}
                      viewportH={viewportH}
                      sectionTop={sectionTops.folder}
                      getKey={(c) => c.folder.id}
                      renderItem={(card) => (
                        <FolderCard
                          folder={card.folder}
                          coverImage={card.coverImage}
                          store={store}
                          pinned={pinnedCovers[card.folder.id] != null}
                          blurred={card.coverImage ? isImageBlurred(card.coverImage.relPath, blurredImages) : false}
                          onOpen={() => navigateToFolder(card.folder.id)}
                          onActions={() => openFolderActions(card.folder)}
                        />
                      )}
                    />
                  )}
                </section>
              )}
              {searchImages.length > 0 && (
                <section ref={imageSectionRef} className="m-section">
                  <h3 className="m-section-label">
                    匹配的图片 <span className="tabular-nums">{searchImages.length}</span>
                  </h3>
                  {viewMode === 'list' ? (
                    <div className="flex flex-col gap-0.5 px-0.5 pb-2">
                      {searchImages.map((img) => (
                        <ImageListRow
                          key={img.id}
                          image={img}
                          store={store}
                          blurred={blurredImages.has(img.relPath)}
                          selectMode={selectMode}
                          selected={selectedIds.has(img.id)}
                          onToggleSelect={toggleSelect}
                          onOpen={() => openViewer(img)}
                          onActions={() => openImageActions(img)}
                        />
                      ))}
                    </div>
                  ) : (
                    <VirtualGrid
                      items={searchImages}
                      cols={IMAGE_COLS}
                      rowHeight={imageRowHeight}
                      gap={IMAGE_GAP}
                      scrollTop={scrollTop}
                      viewportH={viewportH}
                      sectionTop={sectionTops.image}
                      getKey={(img) => img.id}
                      renderItem={(img) => (
                        <ImageCard
                          image={img}
                          store={store}
                          blurred={blurredImages.has(img.relPath)}
                          showName={showFileNames}
                          selectMode={selectMode}
                          selected={selectedIds.has(img.id)}
                          onToggleSelect={toggleSelect}
                          onOpen={() => openViewer(img)}
                          onActions={() => openImageActions(img)}
                        />
                      )}
                    />
                  )}
                </section>
              )}
            </div>
          )
        ) : childFolders.length === 0 && (isRoot || displayImages.length === 0) ? (
          <div className="m-empty-state">
            <div>
            {searchTerm ? (
              <>
                <span className="m-empty-icon"><MobileIcon name="🔍" className="w-6 h-6" /></span>
                <div className="m-empty-title">未找到匹配项</div>
                <div className="m-empty-copy">没有与「{searchQuery}」匹配的子目录或图片</div>
              </>
            ) : (
              <>
                <span className="m-empty-icon"><MobileIcon name="🖼️" className="w-6 h-6" /></span>
                <div className="m-empty-title">{isRoot ? '图库还是空的' : '该目录暂无图片'}</div>
                <div className="m-empty-copy">{isRoot ? '导入照片，开始整理你的图库' : '返回上级或导入新内容'}</div>
                {!isRoot && (
                  <div className="m-empty-actions">
                    <button className="m-primary-button" onClick={() => void handleImport()}>
                      导入相册
                    </button>
                    {selectedFolder && (
                      <button className="m-button" onClick={() => openPrompt({ kind: 'create-folder', folder: selectedFolder })}>
                        新建子文件夹
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            </div>
          </div>
        ) : (
          <div className="m-content-pad">
            {!selectMode && (
              <div className="m-directory-toolbar">
                <span>{isRoot ? '图包排列' : '内容排列'}</span>
                <div className="m-directory-controls">
                  <button
                    type="button"
                    className="m-sort-picker"
                    onClick={openSortSheet}
                    aria-label={`排序方式，当前${SORT_MODE_LABELS[sortMode]}`}
                  >
                    <MobileIcon name="📐" className="w-4 h-4" />
                    <span className="m-sort-picker-value">{SORT_MODE_LABELS[sortMode]}</span>
                    <svg viewBox="0 0 24 24" className="m-sort-picker-chevron" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  <button
                    className="m-sort-direction"
                    disabled={sortMode === 'default'}
                    onClick={() => setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'))}
                    aria-label={sortDirection === 'asc' ? '当前升序，切换为降序' : '当前降序，切换为升序'}
                  >
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {sortDirection === 'asc' ? <path d="M12 19V5M7 10l5-5 5 5" /> : <path d="M12 5v14M7 14l5 5 5-5" />}
                    </svg>
                    <span>{sortDirection === 'asc' ? '升序' : '降序'}</span>
                  </button>
                  <div className="m-view-switch" aria-label="图包和图片布局">
                    <button
                      className={viewMode === 'grid' ? 'is-active' : ''}
                      onClick={() => {
                        setViewMode('grid');
                        localStorage.setItem('kanitsu.viewMode', 'grid');
                      }}
                      aria-label="网格视图"
                      aria-pressed={viewMode === 'grid'}
                    >
                      <MobileIcon name="🔳" className="w-4 h-4" />
                    </button>
                    <button
                      className={viewMode === 'list' ? 'is-active' : ''}
                      onClick={() => {
                        setViewMode('list');
                        localStorage.setItem('kanitsu.viewMode', 'list');
                      }}
                      aria-label="列表视图"
                      aria-pressed={viewMode === 'list'}
                    >
                      <MobileIcon name="☰" className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}
            <section ref={folderSectionRef} className="m-section">
              <div className="m-section-heading">
                <h3 className="m-section-label">{isRoot ? '图包' : '子文件夹'} <span>{childFolders.length}</span></h3>
                {!selectMode && selectedFolder && (
                  <div className="m-section-actions">
                    {isRoot && childFolders.length > 0 && (
                      <button className="m-section-action" onClick={() => void handleImport()}>
                        <MobileIcon name="⬇️" className="w-4 h-4" />
                        <span>导入</span>
                      </button>
                    )}
                    <button className="m-section-action" onClick={() => openPrompt({ kind: 'create-folder', folder: selectedFolder })}>
                      <MobileIcon name="📁" className="w-4 h-4" />
                      <span>新建</span>
                    </button>
                  </div>
                )}
              </div>
              {childFolders.length > 0 && (
                viewMode === 'list' ? (
                  <div className="flex flex-col gap-1 px-0.5 pb-2">
                    {childFolderCards.map((card) => (
                      <FolderListRow
                        key={card.folder.id}
                        folder={card.folder}
                        coverImage={card.coverImage}
                        store={store}
                        pinned={pinnedCovers[card.folder.id] != null}
                        blurred={card.coverImage ? isImageBlurred(card.coverImage.relPath, blurredImages) : false}
                        onOpen={() => navigateToFolder(card.folder.id)}
                        onActions={() => openFolderActions(card.folder)}
                      />
                    ))}
                  </div>
                ) : (
                  <VirtualGrid
                    items={childFolderCards}
                    cols={folderCols}
                    rowHeight={folderRowHeight}
                    gap={FOLDER_GAP}
                    scrollTop={scrollTop}
                    viewportH={viewportH}
                    sectionTop={sectionTops.folder}
                    getKey={(c) => c.folder.id}
                    renderItem={(card) => (
                      <FolderCard
                        folder={card.folder}
                        coverImage={card.coverImage}
                        store={store}
                        pinned={pinnedCovers[card.folder.id] != null}
                        blurred={card.coverImage ? isImageBlurred(card.coverImage.relPath, blurredImages) : false}
                        onOpen={() => navigateToFolder(card.folder.id)}
                        onActions={() => openFolderActions(card.folder)}
                      />
                    )}
                  />
                )
              )}
            </section>
            {!isRoot && (folderImages.length > 0 || aggregateImages.length > 0) && (
              <section ref={imageSectionRef} className="m-section">
                <div className="m-section-heading">
                  <h3 className="m-section-label">
                    {aggregate ? '全部图片' : '当前目录图片'} <span className="tabular-nums">{displayImages.length}</span>
                  </h3>
                  {!selectMode && (
                    <button className="m-section-action" disabled={displayImages.length === 0} onClick={handleEnterSelectMode}>
                      <MobileIcon name="✅" className="w-4 h-4" />
                      <span>选择</span>
                    </button>
                  )}
                </div>
                {!selectMode && (
                  <div className="m-view-toolbar" role="group" aria-label="图片显示选项">
                    <button
                      className={`m-tool-button ${aggregate ? 'is-active' : ''}`}
                      disabled={!aggregate && aggregateImages.length === folderImages.length}
                      onClick={() => setAggregate((value) => !value)}
                      aria-pressed={aggregate}
                    >
                      <MobileIcon name="📚" className="w-4 h-4" />
                      <span>子目录</span>
                    </button>
                    <button
                      className={`m-tool-button ${showFileNames && viewMode === 'grid' ? 'is-active' : ''}`}
                      disabled={viewMode === 'list'}
                      onClick={() => {
                        const next = !showFileNames;
                        setShowFileNames(next);
                        localStorage.setItem('kanitsu.showFileNames', next ? '1' : '0');
                      }}
                      aria-pressed={showFileNames}
                    >
                      <MobileIcon name="🏷️" className="w-4 h-4" />
                      <span>文件名</span>
                    </button>
                  </div>
                )}
                {displayImages.length === 0 ? (
                  <div className="m-inline-empty">当前目录没有图片，开启“子目录”可查看全部图片</div>
                ) : viewMode === 'list' ? (
                  <div className="flex flex-col gap-0.5 px-0.5 pb-2">
                    {displayImages.map((img) => (
                      <ImageListRow
                        key={img.id}
                        image={img}
                        store={store}
                        blurred={blurredImages.has(img.relPath)}
                        selectMode={selectMode}
                        selected={selectedIds.has(img.id)}
                        onToggleSelect={toggleSelect}
                        onOpen={() => openViewer(img)}
                        onActions={() => openImageActions(img)}
                      />
                    ))}
                  </div>
                ) : (
                  <VirtualGrid
                    items={displayImages}
                    cols={IMAGE_COLS}
                    rowHeight={imageRowHeight}
                    gap={IMAGE_GAP}
                    scrollTop={scrollTop}
                    viewportH={viewportH}
                    sectionTop={sectionTops.image}
                    getKey={(img) => img.id}
                    renderItem={(img) => (
                      <ImageCard
                        image={img}
                        store={store}
                        blurred={blurredImages.has(img.relPath)}
                        showName={showFileNames}
                        selectMode={selectMode}
                        selected={selectedIds.has(img.id)}
                        onToggleSelect={toggleSelect}
                        onOpen={() => openViewer(img)}
                        onActions={() => openImageActions(img)}
                      />
                    )}
                  />
                )}
              </section>
            )}
          </div>
        )}
      </main>

      {/* 批量操作栏 */}
      {selectMode && !viewerOpen && (
        <div
          className="m-batch-wrap"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)', zIndex: Z_BATCH_BAR }}
        >
          <div className="m-batch-bar">
            <span className="m-batch-count tabular-nums shrink-0">{selectedIds.size} 张</span>
            <div className="flex-1" />
            <button
              className="m-button"
              disabled={selectedIds.size === 0}
              onClick={() => void handleBatchMove()}
            >
              移动到新文件夹
            </button>
            <button
              className="m-button is-danger"
              disabled={selectedIds.size === 0}
              onClick={() => void handleBatchDelete()}
            >
              删除
            </button>
          </div>
        </div>
      )}

      {/* 底部主导航 / 图包操作 */}
      {!importing && !viewerOpen && !selectMode && (
        <nav className={`m-bottom-dock ${isRoot ? 'is-library' : 'is-package'}`} aria-label={isRoot ? '主导航' : '图包操作'}>
          {isRoot ? (
            <>
              <button className="m-dock-button is-active" aria-current="page">
                <MobileIcon name="🏠" className="w-5 h-5" />
                <span>图库</span>
              </button>
              <button className="m-dock-button" onClick={openTools}>
                <MobileIcon name="📐" className="w-5 h-5" />
                <span>工具</span>
              </button>
            </>
          ) : (
            <>
              <button className="m-dock-button" disabled={displayImages.length === 0} onClick={handleEnterSelectMode}>
                <MobileIcon name="✅" className="w-5 h-5" />
                <span>选择</span>
              </button>
              <button className="m-dock-button is-primary" disabled={!selectedFolder} onClick={() => selectedFolder && openOrganizeFor(selectedFolder)}>
                <MobileIcon name="🧹" className="w-5 h-5" />
                <span>智能整理</span>
              </button>
              <button className="m-dock-button" disabled={!selectedFolder} onClick={() => selectedFolder && void handleExport(selectedFolder)}>
                <MobileIcon name="⬆️" className="w-5 h-5" />
                <span>导出</span>
              </button>
            </>
          )}
        </nav>
      )}

      {/* 抽屉 */}
      {drawerOpen && (
        <div className="fixed inset-0" style={{ zIndex: Z_DRAWER }}>
          <div className="m-drawer-mask m-overlay-scrim absolute inset-0" onClick={() => closeOverlay('drawer')} />
          <aside className="m-directory-panel absolute inset-0 flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
            <div className="m-directory-header shrink-0">
              <button className="m-icon-button" onClick={() => closeOverlay('drawer')} aria-label="关闭目录">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
              <div className="m-drawer-brand shrink-0">
                <KanitsuLogo className="object-contain shrink-0" alt="" aria-hidden="true" />
                <span className="m-drawer-brand-copy">
                  <strong>目录</strong>
                  <span>浏览你的本地图包</span>
                </span>
              </div>
            </div>
            <div className="m-drawer-tree" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}>
              {rootFolder && (
                <button
                  className={`m-tree-row m-tree-root ${isRoot ? 'is-selected' : ''}`}
                  onClick={() => {
                    if (isRoot) closeOverlay('drawer');
                    else navigateFromDrawer(rootFolder.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 10.5L12 3l9 7.5V21H3z" />
                  </svg>
                  <span className="m-tree-title flex-1">全部图包</span>
                  <span className="m-tree-count">{rootFolder.imageCount}</span>
                </button>
              )}
              {snapshot && (
                <MobileFolderTree
                  snapshot={snapshot}
                  folderId={snapshot.rootId}
                  selectedFolderId={currentFolderId}
                  expandedFolders={expandedFolders}
                  onSelect={(folder) => {
                    navigateFromDrawer(folder.id);
                  }}
                  onToggle={toggleFolderExpand}
                  depth={0}
                />
              )}
            </div>
          </aside>
        </div>
      )}

      {/* 查看器 */}
      {viewerOpen && (
        <MobileViewer
          key={viewerSessionId}
          images={viewerImages}
          index={viewerIndex}
          store={store}
          onClose={() => closeOverlay('viewer')}
          onNavigate={(id) => setViewerImageId(id)}
          onShowActions={(img) => openImageActions(img, true)}
        />
      )}

      {/* 整理预览（全屏化桌面组件） */}
      {organizePreview && (
        <div className="m-fullscreen">
          <OrganizePreview
            bindings={organizePreview.bindings}
            organizing={organizing}
            progress={organizeProgress}
            onChange={(bindings) => setOrganizePreview((prev) => (prev ? { ...prev, bindings } : prev))}
            onApply={() => void handleApplyOrganize()}
            onClose={() => closeOverlay('organize')}
          />
        </div>
      )}

      {/* 封面选择（全屏化桌面组件） */}
      {coverPickerFolder && snapshot && (
        <div className="m-fullscreen">
          <CoverPickerModal
            folderId={coverPickerFolder.id}
            snapshot={snapshot}
            store={store}
            pinnedCovers={pinnedCovers}
            currentCoverId={pinnedCovers[coverPickerFolder.id] ?? null}
            onPick={(imageId) => {
              const name = imageId ? snapshot.images[imageId]?.name : undefined;
              pinCover(coverPickerFolder.id, imageId, name);
              closeOverlay('cover');
            }}
            onCancel={() => closeOverlay('cover')}
          />
        </div>
      )}

      {/* 设置 */}
      {showTools && (
        <MobileToolsScreen
          onBack={() => closeOverlay('tools')}
          onOpenSettings={openSettings}
          onImport={() => void handleImport()}
          imageCount={libraryStats.imageCount}
          importReport={importReport}
          lastManifest={lastManifest}
          organizing={organizing}
          onOrganize={() => {
            if (rootFolder) openOrganizeFor(rootFolder);
          }}
          onExport={() => {
            if (rootFolder) void handleExport(rootFolder);
          }}
          onUndo={() => void handleUndoOrganize()}
          onShowReport={() => {
            setShowReport(true);
            openOverlay('report');
          }}
        />
      )}
      {showSettings && (
        <MobileSettingsScreen rules={customRules} onChange={handleCustomRulesChange} onBack={() => closeOverlay('settings')} />
      )}

      {/* 动作面板 */}
      {sheet && <MobileActionSheet title={sheet.title} subtitle={sheet.subtitle} actions={sheet.actions} onClose={() => closeOverlay('sheet')} />}

      {/* 删除确认 */}
      {deleteTarget && (
        <MobileConfirmDialog
          title="确认删除"
          body={
            deleteTarget.kind === 'image'
              ? `确定要删除图片「${deleteTarget.image.name}」吗？此操作不可撤销。`
              : `确定要删除相册「${deleteTarget.folder.name}」及其全部子目录吗？此操作不可撤销。`
          }
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => closeOverlay('dialog')}
        />
      )}

      {/* 输入对话框 */}
      {promptState && (
        <MobilePromptDialog
          title={
            promptState.kind === 'rename-image'
              ? '重命名图片'
              : promptState.kind === 'rename-folder'
                ? '重命名相册'
                : promptState.kind === 'batch-move'
                  ? `移动 ${promptState.count} 张图片到新文件夹`
                  : `在「${promptState.folder.name || '全部相册'}」中新建子文件夹`
          }
          label={promptState.kind === 'create-folder' || promptState.kind === 'batch-move' ? '文件夹名称' : '新名称'}
          initialValue={
            promptState.kind === 'rename-image'
              ? promptState.image.name
              : promptState.kind === 'rename-folder'
                ? promptState.folder.name
                : ''
          }
          confirmLabel={promptState.kind === 'create-folder' || promptState.kind === 'batch-move' ? '创建' : '保存'}
          onSubmit={(v) => void handlePromptSubmit(v)}
          onCancel={() => closeOverlay('dialog')}
        />
      )}

      {/* 导入报告 */}
      {showReport && importReport && (
        <div className="m-dialog-mask fixed inset-0 flex items-end justify-center" style={{ zIndex: Z_DIALOG }}>
          <div className="m-overlay-scrim absolute inset-0" onClick={() => closeOverlay('report')} />
          <div
            className="m-sheet-panel relative w-full max-h-[70vh] flex flex-col"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
          >
            <div className="m-sheet-handle-wrap" aria-hidden="true"><span className="m-sheet-handle" /></div>
            <div className="m-sheet-header">
              <strong>导入报告</strong>
              <span>
                来源：{importReport.sourceFolderName} · 扫描 {importReport.scannedFileCount} · 复制 {importReport.copiedImageCount} · 跳过 {importReport.skippedCount} · 失败 {importReport.errors.length}
              </span>
            </div>
            <div className="m-sheet-content m-report-content flex-1">
              {importReport.skippedFiles.length === 0 && importReport.errors.length === 0 ? (
                <p className="m-report-empty">全部成功，没有跳过或失败的文件。</p>
              ) : (
                <>
                  {importReport.skippedFiles.map((f, i) => (
                    <div key={`s-${i}`} className="m-report-row is-warning">
                      <span className="shrink-0">跳过</span>
                      <span className="font-mono break-all flex-1">{f.path}</span>
                      <span className="m-report-reason shrink-0">{skippedReasonLabel(f.reason)}</span>
                    </div>
                  ))}
                  {importReport.errors.map((e, i) => (
                    <div key={`e-${i}`} className="m-report-row is-error">
                      <span className="shrink-0">失败</span>
                      <span className="font-mono break-all flex-1">{e}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="m-sheet-footer">
              <button className="m-sheet-cancel" onClick={() => closeOverlay('report')}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 整理结果 */}
      {organizeResult && (
        <div className="m-dialog-mask fixed inset-0 flex items-center justify-center p-8" style={{ zIndex: Z_DIALOG }}>
          <div className="m-overlay-scrim absolute inset-0" onClick={() => setOrganizeResult(null)} />
          <div className="m-dialog relative w-full max-w-sm p-5 max-h-[70vh] flex flex-col">
            <h3 className="m-dialog-title shrink-0">整理结果</h3>
            <p className="m-dialog-copy shrink-0">
              已应用 {organizeResult.appliedCount} · 跳过低置信度 {organizeResult.skippedLowConfidenceCount} · 冲突 {organizeResult.conflicts.length}
            </p>
            {organizeResult.conflicts.length > 0 && (
              <div className="flex-1 overflow-y-auto mt-3 min-h-0">
                {organizeResult.conflicts.map((c, i) => (
                  <div key={i} className="m-conflict-row block">
                    <div className="font-mono break-all">{c.name}</div>
                    <div className="m-conflict-detail">
                      → {c.targetRelPath}（{conflictReasonLabel(c.reason)}）
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button className="m-button is-full mt-4 shrink-0" onClick={() => setOrganizeResult(null)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 任务进度 */}
      {importing && (
        <MobileProgressCard
          title="正在导入相册…"
          detail={importProgress ? `已扫描 ${importProgress.scanned} · 已复制 ${importProgress.copied} · 跳过 ${importProgress.skipped}` : undefined}
          onCancel={cancelImport}
        />
      )}
      {organizing && organizeProgress && (
        <MobileProgressCard title="正在整理…" done={organizeProgress.done} total={organizeProgress.total} onCancel={cancelOrganize} />
      )}
      {exporting && (
        <MobileProgressCard title="正在导出 ZIP…" done={exportProgress?.done} total={exportProgress?.total} onCancel={cancelExport} />
      )}

      {/* Toast */}
      {toast && !viewerOpen && <MobileToast text={toast.text} kind={toast.kind} />}
    </div>
  );
}
