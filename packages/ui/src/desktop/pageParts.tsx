/**
 * 首页与图包页的页面部件：首页标题 / 继续浏览、图包封面页头 / 子图包带 / 吸顶工具栏、
 * 状态栏、多选浮动栏、空状态。均为纯展示组件，数据与动作由 LibraryBrowser 传入。
 */
import { Fragment, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import {
  ArrowsLeftRight,
  CaretDown,
  CaretUp,
  CaretRight,
  CheckCircle,
  CloudSlash,
  Copy,
  DotsThree,
  EyeSlash,
  FileZip,
  FolderOpen,
  FolderPlus,
  ImageSquare,
  ImagesSquare,
  List,
  MagicWand,
  MagnifyingGlass,
  Minus,
  Plus,
  PushPin,
  ShieldCheck,
  SidebarSimple,
  SortAscending,
  SquaresFour,
  Stack,
  Tag,
  Trash,
  ArrowCounterClockwise,
  UploadSimple,
  X,
  Rows,
} from '@phosphor-icons/react';
import type { FolderNode, ImageEntry } from '../../../core/src/index';
import type { LibraryStore } from '../../../fs-adapter/src/types';
import { BlobImage } from '../BlobImage';
import { COVER_THUMBNAIL_SIZE } from '../thumbnailCache';
import { Segmented } from './controls';
import type { GalleryLayoutMode } from './galleryLayout';
import {
  formatBytes,
  formatCount,
  imageFileRef,
  IMAGE_SORT_LABELS,
  PACK_SORT_LABELS,
  type ImageSort,
  type LibraryFilter,
  type PackSort,
  type PackView,
  type SortDir,
} from './shared';

// —— 列表视图表头 ——

export interface ListColumn<K extends string> {
  label: string;
  /** 可排序列对应的排序键；缺省表示该列不能排序。 */
  sort?: K;
}

/**
 * 列表视图的表头：可排序列是按钮，点击切换排序；再点同一列切换升降序（onSort 自行决定）。
 * 空 label 的列只占位（复选框、缩略图、操作列）。
 */
export function ListHeader<K extends string>({
  columns,
  active,
  dir,
  onSort,
  className,
}: {
  columns: ReadonlyArray<ListColumn<K>>;
  active: K;
  /** 图片列表有升降序；图包列表没有方向时不传。 */
  dir?: SortDir;
  onSort: (key: K) => void;
  className?: string;
}) {
  return (
    <div className={`dk-lhead ${className ?? ''}`}>
      {columns.map((column, i) => {
        if (!column.sort) return <span key={i}>{column.label}</span>;
        const on = column.sort === active;
        const Caret = on && dir === 'desc' ? CaretUp : CaretDown;
        return (
          <button
            key={i}
            type="button"
            className={on ? 'on' : ''}
            aria-pressed={on}
            title={on && dir ? `按${column.label}排序 · ${dir === 'asc' ? '升序' : '降序'}（再点切换）` : `按${column.label}排序`}
            onClick={() => onSort(column.sort!)}
          >
            {column.label}
            {on && <Caret size={10} weight="bold" />}
          </button>
        );
      })}
    </div>
  );
}

// —— 首页 ——

export function HomeHeader({
  filter,
  packCount,
  imageCount,
  bytes,
  onFilter,
}: {
  filter: LibraryFilter;
  packCount: number;
  imageCount: number;
  bytes: number;
  onFilter: (filter: LibraryFilter) => void;
}) {
  const title = filter === 'recent' ? '最近导入' : filter === 'pinned' ? '已固定封面' : '图库';
  const chip = (value: LibraryFilter, label: string) => (
    <button type="button" className={`dk-chip ${filter === value ? 'on' : ''}`} aria-pressed={filter === value} onClick={() => onFilter(value)}>
      {label}
    </button>
  );
  return (
    <div className="dk-home-h">
      <div>
        <h1>{title}</h1>
        <div className="dk-meta num">{formatCount(packCount)} 个图包 · {formatCount(imageCount)} 张图片 · {formatBytes(bytes)}</div>
      </div>
      <span className="dk-spacer" />
      <div className="dk-chips" role="group" aria-label="图包筛选">
        {chip('all', '全部')}
        {chip('recent', '最近导入')}
        {chip('pinned', '已固定封面')}
      </div>
    </div>
  );
}

export interface ContinueCardData {
  folder: FolderNode;
  image: ImageEntry;
  position: number;
  total: number;
}

export function ContinueBrowsing({
  items,
  store,
  blurredImages,
  onResume,
}: {
  items: readonly ContinueCardData[];
  store: LibraryStore;
  blurredImages: ReadonlySet<string>;
  onResume: (item: ContinueCardData) => void;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="dk-sec-h">
        <h2>继续浏览</h2>
        <span className="dk-spacer" />
        <span className="dk-hint-inline"><ShieldCheck size={13} />位置只记录在本机</span>
      </div>
      <div className="dk-cont">
        {items.map((item) => {
          const blurred = blurredImages.has(item.image.relPath);
          return (
            <button key={item.folder.id} type="button" className="dk-cont-card" onClick={() => onResume(item)}>
              <span className="dk-th">
                <BlobImage store={store} fileRef={imageFileRef(item.image)} alt="" className="dk-art" thumbnail lazy blur={blurred} />
              </span>
              <span className="dk-bd">
                <strong>{item.folder.name}</strong>
                <small className="num">看到第 {item.position + 1} / {item.total} 张 · {item.image.name}</small>
                <span className="dk-pb"><i style={{ width: `${((item.position + 1) / item.total) * 100}%` }} /></span>
              </span>
              <span className="dk-go"><CaretRight size={16} /></span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function SectionHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="dk-sec-h">
      <h2>
        {title}
        {count != null && <small className="num">{formatCount(count)}</small>}
      </h2>
      <span className="dk-spacer" />
      {children}
    </div>
  );
}

export function PackViewControls({
  sort,
  view,
  onSortMenu,
  onView,
}: {
  sort: PackSort;
  view: PackView;
  onSortMenu: (anchor: HTMLElement) => void;
  onView: (view: PackView) => void;
}) {
  return (
    <>
      <button type="button" className="dk-dd" aria-haspopup="menu" onClick={(event) => onSortMenu(event.currentTarget)}>
        <SortAscending size={15} />
        {PACK_SORT_LABELS[sort]}
        <CaretDown size={11} />
      </button>
      <Segmented<PackView>
        label="图包视图"
        value={view}
        onChange={onView}
        options={[
          { value: 'grid', label: '封面', content: <SquaresFour size={15} /> },
          { value: 'list', label: '列表', content: <List size={15} /> },
        ]}
      />
    </>
  );
}

// —— 图包页 ——

export function PackHero({
  store,
  folder,
  crumbs,
  cover,
  coverPinned,
  coverBlurred,
  imageCount,
  bytes,
  importedLabel,
  busy,
  exporting,
  allBlurred,
  undoLabel,
  onCrumb,
  onRoot,
  onOrganize,
  onExport,
  onCover,
  onToggleBlur,
  onUndo,
  onMore,
}: {
  store: LibraryStore;
  folder: FolderNode;
  crumbs: readonly FolderNode[];
  cover: ImageEntry | null;
  coverPinned: boolean;
  coverBlurred: boolean;
  imageCount: number;
  bytes: number;
  importedLabel?: string;
  busy: boolean;
  exporting: boolean;
  allBlurred: boolean;
  /** 有可撤销的最近一次整理 / 移动 / 合并时给出按钮文案。 */
  undoLabel: string | null;
  onCrumb: (folder: FolderNode) => void;
  onRoot: () => void;
  onOrganize: () => void;
  onExport: () => void;
  onCover: () => void;
  onToggleBlur: () => void;
  onUndo: () => void;
  onMore: (anchor: HTMLElement) => void;
}) {
  const coverNode = cover ? (
    <BlobImage store={store} fileRef={imageFileRef(cover)} alt="" className="dk-art" thumbnail thumbnailSize={coverPinned ? COVER_THUMBNAIL_SIZE : undefined} blur={coverBlurred} />
  ) : null;
  return (
    <section className="dk-hero">
      <div className="dk-bg" aria-hidden="true">{coverNode}</div>
      <div className="dk-fg">
        <div className="dk-poster">
          {coverNode ?? <span className="dk-cover-empty"><ImagesSquare size={30} weight="duotone" /></span>}
          {coverPinned && <span className="dk-badge dk-pin"><PushPin size={11} weight="fill" />封面</span>}
        </div>
        <div className="dk-info">
          <nav className="dk-crumbs" aria-label="面包屑">
            <button type="button" onClick={onRoot}>图库</button>
            {crumbs.slice(0, -1).map((crumb) => (
              <Fragment key={crumb.id}>
                <CaretRight size={11} />
                <button type="button" onClick={() => onCrumb(crumb)}>{crumb.name}</button>
              </Fragment>
            ))}
          </nav>
          <h1 title={folder.name}>{folder.name}</h1>
          <div className="dk-meta num">
            {formatCount(imageCount)} 张图片
            {folder.childCount > 0 ? ` · ${formatCount(folder.childCount)} 个子图包` : ''}
            {` · ${formatBytes(bytes)}`}
            {importedLabel ? ` · 导入于 ${importedLabel}` : ''}
          </div>
          <div className="dk-hero-actions">
            <button type="button" className="dk-btn primary" disabled={busy || imageCount === 0} onClick={onOrganize}><MagicWand size={16} />智能整理</button>
            <button type="button" className="dk-btn" disabled={busy || exporting || imageCount === 0} onClick={onExport}><FileZip size={16} />{exporting ? '正在导出' : '导出 ZIP'}</button>
            <button type="button" className="dk-btn" disabled={imageCount === 0} onClick={onCover}><ImageSquare size={16} />设置封面</button>
            <button type="button" className={`dk-btn ${allBlurred ? 'on' : ''}`} disabled={imageCount === 0} aria-pressed={allBlurred} onClick={onToggleBlur}>
              <EyeSlash size={16} />{allBlurred ? '取消隐私预览' : '隐私预览'}
            </button>
            {undoLabel && <button type="button" className="dk-btn" disabled={busy} onClick={onUndo}><ArrowCounterClockwise size={16} />{undoLabel}</button>}
            <button type="button" className="dk-btn" title="更多" aria-label="更多操作" onClick={(event) => onMore(event.currentTarget)}><DotsThree size={18} weight="bold" /></button>
          </div>
        </div>
      </div>
    </section>
  );
}

export interface SubPackData {
  folder: FolderNode;
  cover: ImageEntry | null;
  bytes: number;
}

/** 横向子图包卡片带；数量较多时只列前若干个，末尾是「全部子图包」入口。 */
export const SUBPACK_STRIP_LIMIT = 24;

export function SubPackStrip({
  items,
  total,
  store,
  blurredImages,
  onOpen,
  onContextMenu,
  onShowAll,
  onCreate,
}: {
  items: readonly SubPackData[];
  total: number;
  store: LibraryStore;
  blurredImages: ReadonlySet<string>;
  onOpen: (folder: FolderNode) => void;
  onContextMenu: (event: ReactMouseEvent, folder: FolderNode) => void;
  onShowAll: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="dk-subs" role="list" aria-label="子图包">
      {items.map(({ folder, cover, bytes }) => {
        const blurred = cover ? blurredImages.has(cover.relPath) : false;
        return (
          <button key={folder.id} type="button" role="listitem" className="dk-sub-card" onClick={() => onOpen(folder)} onContextMenu={(event) => onContextMenu(event, folder)}>
            <span className="dk-th">
              {cover ? <BlobImage store={store} fileRef={imageFileRef(cover)} alt="" className="dk-art" thumbnail lazy blur={blurred} /> : <span className="dk-cover-empty"><ImagesSquare size={24} weight="duotone" /></span>}
              <span className="dk-badge br num">{formatCount(folder.imageCount)}</span>
            </span>
            <strong>{folder.name}</strong>
            <small className="num">{folder.childCount > 0 ? `${folder.childCount} 个子图包 · ` : ''}{formatBytes(bytes)}</small>
          </button>
        );
      })}
      {total > items.length ? (
        <button type="button" role="listitem" className="dk-sub-card new" onClick={onShowAll}>
          <span className="dk-th"><Stack size={26} /></span>
          <strong>全部 {formatCount(total)} 个子图包</strong>
        </button>
      ) : (
        <button type="button" role="listitem" className="dk-sub-card new" onClick={onCreate}>
          <span className="dk-th"><FolderPlus size={24} /></span>
          <strong className="dk-muted">新建子图包</strong>
        </button>
      )}
    </div>
  );
}

export function ImageToolbar({
  toolbarRef,
  stuck,
  store,
  folder,
  cover,
  coverBlurred,
  count,
  hasChildren,
  includeSubfolders,
  filterText,
  sort,
  sortDir,
  layout,
  showNames,
  inspectorOpen,
  onToggleSubfolders,
  onClearFilter,
  onSortMenu,
  onLayout,
  onToggleNames,
  onToggleInspector,
}: {
  toolbarRef: RefObject<HTMLDivElement>;
  /** 已吸顶：显示图包名与缩略封面。 */
  stuck: boolean;
  store: LibraryStore;
  folder: FolderNode;
  cover: ImageEntry | null;
  /** 封面开了隐私预览：吸顶的迷你封面同样打码。 */
  coverBlurred: boolean;
  count: number;
  hasChildren: boolean;
  includeSubfolders: boolean;
  filterText: string;
  sort: ImageSort;
  sortDir: SortDir;
  layout: GalleryLayoutMode;
  showNames: boolean;
  inspectorOpen: boolean;
  onToggleSubfolders: () => void;
  onClearFilter: () => void;
  onSortMenu: (anchor: HTMLElement) => void;
  onLayout: (layout: GalleryLayoutMode) => void;
  onToggleNames: () => void;
  onToggleInspector: () => void;
}) {
  return (
    <div ref={toolbarRef} className={`dk-itb ${stuck ? 'stuck' : ''}`}>
      <div className="dk-mini" aria-hidden="true">
        <span className="dk-p">{cover && <BlobImage store={store} fileRef={imageFileRef(cover)} alt="" className="dk-art" thumbnail lazy blur={coverBlurred} />}</span>
        <strong>{folder.name}</strong>
      </div>
      <span className="dk-vr" />
      <h2>图片<small className="num">{formatCount(count)}</small></h2>
      {hasChildren && (
        <button type="button" className={`dk-tog ${includeSubfolders ? 'on' : ''}`} role="switch" aria-checked={includeSubfolders} onClick={onToggleSubfolders}>
          <span className="dk-sw" />含子目录
        </button>
      )}
      {filterText && (
        <button type="button" className="dk-chip on" onClick={onClearFilter} title="清除筛选">
          <MagnifyingGlass size={13} />「{filterText}」<X size={12} />
        </button>
      )}
      <span className="dk-spacer" />
      <button type="button" className="dk-dd" aria-haspopup="menu" onClick={(event) => onSortMenu(event.currentTarget)}>
        <SortAscending size={15} />
        {IMAGE_SORT_LABELS[sort]} · {sortDir === 'asc' ? '升序' : '降序'}
        <CaretDown size={11} />
      </button>
      <Segmented<GalleryLayoutMode>
        label="图片布局"
        value={layout}
        onChange={onLayout}
        options={[
          { value: 'grid', label: '网格', content: <SquaresFour size={15} /> },
          { value: 'justified', label: '按原比例', content: <Rows size={15} /> },
          { value: 'list', label: '列表', content: <List size={15} /> },
        ]}
      />
      <button type="button" className={`dk-ib ${showNames ? 'on' : ''}`} aria-pressed={showNames} title="显示文件名" aria-label="显示文件名" disabled={layout === 'list'} onClick={onToggleNames}>
        <Tag size={16} />
      </button>
      <button type="button" className={`dk-ib ${inspectorOpen ? 'on' : ''}`} aria-pressed={inspectorOpen} title="检查器 (Ctrl+I)" aria-label="检查器" onClick={onToggleInspector}>
        <SidebarSimple size={16} mirrored />
      </button>
    </div>
  );
}

// —— 状态栏与多选栏 ——

export function StatusBar({
  left,
  task,
  zoom,
}: {
  left: ReactNode;
  task: { title: string; done: number; total: number } | null;
  zoom: { value: number; min: number; max: number; onChange: (value: number) => void; onStep: (dir: 1 | -1) => void } | null;
}) {
  return (
    <footer className="dk-status">
      {left}
      <span className="dk-spacer" />
      {task && (
        <span className="dk-task-st">
          <span className="dk-spin" />
          {task.title}
          <span className="dk-pb"><i style={{ width: task.total > 0 ? `${(Math.min(task.done, task.total) / task.total) * 100}%` : '6%' }} /></span>
          <span className="num">{task.total > 0 ? `${task.done}/${task.total}` : '准备中'}</span>
        </span>
      )}
      <span className="dk-spacer" />
      {zoom && (
        <div className="dk-zoomer" title="缩略图尺寸（Ctrl + 滚轮）">
          <button type="button" className="dk-ib" aria-label="缩小缩略图" onClick={() => zoom.onStep(-1)}><Minus size={12} /></button>
          <input
            type="range"
            aria-label="缩略图尺寸"
            min={zoom.min}
            max={zoom.max}
            value={zoom.value}
            onChange={(event) => zoom.onChange(Number(event.target.value))}
          />
          <button type="button" className="dk-ib" aria-label="放大缩略图" onClick={() => zoom.onStep(1)}><Plus size={12} /></button>
        </div>
      )}
    </footer>
  );
}

export function SelectionBar({
  imageCount,
  folderCount,
  busy,
  canExport,
  allBlurred,
  onMove,
  onCover,
  onBlur,
  onExport,
  onMerge,
  onDelete,
  onClear,
}: {
  imageCount: number;
  folderCount: number;
  busy: boolean;
  canExport: boolean;
  allBlurred: boolean;
  onMove: () => void;
  onCover: (() => void) | null;
  onBlur: () => void;
  onExport: () => void;
  onMerge: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const total = imageCount + folderCount;
  if (total === 0) return null;
  return (
    <div className="dk-selbar" role="toolbar" aria-label="所选项目操作">
      <span className="dk-cnt">
        <i><CheckCircle size={20} weight="fill" /></i>
        <span className="num">
          {[imageCount ? `${formatCount(imageCount)} 张` : '', folderCount ? `${formatCount(folderCount)} 个图包` : ''].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="dk-vr" />
      <button type="button" className="dk-a" disabled={busy} onClick={onMove}><ArrowsLeftRight size={16} />移动到…</button>
      {onCover && <button type="button" className="dk-a" onClick={onCover}><PushPin size={16} />设为封面</button>}
      <button type="button" className="dk-a" onClick={onBlur}><EyeSlash size={16} />{allBlurred ? '取消隐私预览' : '隐私预览'}</button>
      {canExport && <button type="button" className="dk-a" disabled={busy} onClick={onExport}><FileZip size={16} />导出 ZIP</button>}
      {total > 1 && <button type="button" className="dk-a" disabled={busy} onClick={onMerge}><Stack size={16} />合并为新图包</button>}
      <button type="button" className="dk-a danger" disabled={busy} onClick={onDelete}><Trash size={16} />删除</button>
      <span className="dk-vr" />
      <button type="button" className="dk-ib" title="取消选择 (Esc)" aria-label="取消选择" onClick={onClear}><X size={15} /></button>
    </div>
  );
}

// —— 空状态 ——

export function FirstRun({ canDrop, importing, onImport }: { canDrop: boolean; importing: boolean; onImport: () => void }) {
  return (
    <div className="dk-first">
      <div className="dk-dz">
        <div className="dk-big"><UploadSimple size={26} /></div>
        <h2>导入第一个图包</h2>
        <p>{canDrop ? '把文件夹拖进窗口，或点击选择。' : '点击选择一个文件夹。'}Kanitsu 会复制一份到自己的图库，之后的整理都只作用于这份副本。</p>
        <button type="button" className="dk-btn primary" disabled={importing} onClick={onImport}><FolderOpen size={16} />选择文件夹…</button>
        <div className="dk-fmts">JPG · PNG · WebP · AVIF · BMP · GIF · HEIC · 主流相机 RAW</div>
      </div>
      <div className="dk-three">
        <div><b><Copy size={16} />只复制</b>源文件夹不会被改名、移动或删除。</div>
        <div><b><CloudSlash size={16} />完全离线</b>不联网、不上传，也没有遥测。</div>
        <div><b><ArrowCounterClockwise size={16} />可撤销</b>整理先预览再落盘，最近一次可以撤销。</div>
      </div>
    </div>
  );
}

/** 空状态；compact 用于弹层 / 对话框内的小块空状态。 */
export function EmptyState({
  icon,
  title,
  text,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'dk-empty compact' : 'dk-empty'}>
      <div>
        {icon != null && <div className="dk-ico">{icon}</div>}
        <h3>{title}</h3>
        <p>{text}</p>
        {action}
      </div>
    </div>
  );
}
