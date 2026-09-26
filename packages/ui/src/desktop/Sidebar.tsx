/**
 * 桌面侧栏：图库筛选（全部 / 最近导入 / 已固定）+ 带封面缩略图的图包目录树 +
 * 底部图库占用与设置入口。目录树按固定行高扁平化后分块窗口化，只挂载可视行。
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { CaretRight, Clock, GearSix, ImagesSquare, Plus, PushPin } from '@phosphor-icons/react';
import type { FolderNode, ImageEntry, LibrarySnapshot } from '../../../core/src/index';
import type { LibraryStore } from '../../../fs-adapter/src/types';
import { BlobImage } from '../BlobImage';
import { SidebarResizeHandle } from '../SidebarResizeHandle';
import { formatBytes, formatCount, imageFileRef, type LibraryFilter } from './shared';

export const FOLDER_TREE_ROW_HEIGHT = 32;
const FOLDER_TREE_OVERSCAN_ROWS = 8;
const FOLDER_TREE_WINDOW_BLOCK_ROWS = 8;
const FOLDER_TREE_INITIAL_ROWS = 32;

type FolderTreeRow = {
  folder: FolderNode;
  depth: number;
  positionInSet: number;
  setSize: number;
};

type FolderTreeWindow = { first: number; last: number };

export function buildFolderChildren(snapshot: LibrarySnapshot): ReadonlyMap<string, readonly FolderNode[]> {
  const children = new Map<string, FolderNode[]>();
  for (const folder of Object.values(snapshot.folders)) {
    if (!folder.parentId) continue;
    const siblings = children.get(folder.parentId);
    if (siblings) siblings.push(folder);
    else children.set(folder.parentId, [folder]);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  return children;
}

export function flattenFolderTree(
  folderId: string,
  children: ReadonlyMap<string, readonly FolderNode[]>,
  expanded: (id: string) => boolean,
): FolderTreeRow[] {
  const rows: FolderTreeRow[] = [];
  const stack: FolderTreeRow[] = [];
  const push = (list: readonly FolderNode[], depth: number) => {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      stack.push({ folder: list[index]!, depth, positionInSet: index + 1, setSize: list.length });
    }
  };
  push(children.get(folderId) ?? [], 0);
  while (stack.length > 0) {
    const row = stack.pop()!;
    rows.push(row);
    if (expanded(row.folder.id)) push(children.get(row.folder.id) ?? [], row.depth + 1);
  }
  return rows;
}

function folderTreeWindowFor(rowCount: number, scrollTop: number, viewportHeight: number): FolderTreeWindow {
  if (rowCount <= 0) return { first: 0, last: 0 };
  const visibleRows = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / FOLDER_TREE_ROW_HEIGHT));
  const maxVisibleStart = Math.max(0, rowCount - visibleRows);
  const visibleStart = Math.min(maxVisibleStart, Math.max(0, Math.floor(Math.max(0, scrollTop) / FOLDER_TREE_ROW_HEIGHT)));
  const first = Math.floor(Math.max(0, visibleStart - FOLDER_TREE_OVERSCAN_ROWS) / FOLDER_TREE_WINDOW_BLOCK_ROWS) * FOLDER_TREE_WINDOW_BLOCK_ROWS;
  const lastCandidate = Math.min(rowCount, visibleStart + visibleRows + FOLDER_TREE_OVERSCAN_ROWS);
  const last = Math.min(rowCount, Math.ceil(lastCandidate / FOLDER_TREE_WINDOW_BLOCK_ROWS) * FOLDER_TREE_WINDOW_BLOCK_ROWS);
  return { first, last };
}

export interface PickTreeOptions {
  /** 选择模式（移动到…）：点击行只选中不导航。 */
  onPick?: (folder: FolderNode) => void;
  pickedId?: string | null;
  /** 不可选的目录（移动时的源图包及其子树）。 */
  isDisabled?: (folder: FolderNode) => boolean;
}

export const FolderTree = memo(function FolderTree({
  snapshot,
  selectedFolderId,
  onSelect,
  expandedFolders,
  onToggleFolder,
  onFolderContextMenu,
  scrollRootRef,
  store,
  coverFor,
  blurredImages,
  freshFolders,
  pick,
}: {
  snapshot: LibrarySnapshot;
  selectedFolderId: string;
  onSelect: (folder: FolderNode) => void;
  expandedFolders: ReadonlySet<string>;
  onToggleFolder: (id: string) => void;
  onFolderContextMenu?: (event: ReactMouseEvent, folder: FolderNode) => void;
  scrollRootRef: RefObject<HTMLDivElement | null>;
  store: LibraryStore;
  coverFor: (folderId: string) => ImageEntry | null;
  blurredImages: ReadonlySet<string>;
  /** 新导入尚未打开过的图包：行尾显示小圆点。 */
  freshFolders?: ReadonlySet<string>;
  pick?: PickTreeOptions;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const children = useMemo(() => buildFolderChildren(snapshot), [snapshot]);
  const rows = useMemo(
    () => flattenFolderTree(snapshot.rootId, children, (id) => expandedFolders.has(id)),
    [children, expandedFolders, snapshot.rootId],
  );
  const rowCountRef = useRef(rows.length);
  rowCountRef.current = rows.length;
  const [windowRows, setWindowRows] = useState<FolderTreeWindow>({ first: 0, last: Math.min(rows.length, FOLDER_TREE_INITIAL_ROWS) });

  const updateWindow = useCallback(() => {
    const root = scrollRootRef.current;
    const local = scrollRef.current;
    if (!root || !local) return;
    const localScrollTop = Math.max(0, root.scrollTop - local.offsetTop);
    const next = folderTreeWindowFor(rowCountRef.current, localScrollTop, root.clientHeight);
    setWindowRows((current) => (current.first === next.first && current.last === next.last ? current : next));
  }, [scrollRootRef]);

  const onScroll = useCallback(() => {
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateWindow();
    });
  }, [updateWindow]);

  useLayoutEffect(() => updateWindow(), [rows.length, updateWindow]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(updateWindow);
    observer.observe(root);
    if (scrollRef.current) observer.observe(scrollRef.current);
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      root.removeEventListener('scroll', onScroll);
      if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
    };
  }, [onScroll, scrollRootRef, updateWindow]);

  return (
    <div ref={scrollRef} className="dk-tree">
      <ul className="dk-tree-list" style={{ height: rows.length * FOLDER_TREE_ROW_HEIGHT }} role="tree" aria-label="图包目录">
        {rows.slice(windowRows.first, windowRows.last).map((row, windowIndex) => {
          const { folder, depth, positionInSet, setSize } = row;
          const hasChildren = folder.childCount > 0;
          const expanded = expandedFolders.has(folder.id);
          const active = pick ? pick.pickedId === folder.id : folder.id === selectedFolderId;
          const disabled = pick?.isDisabled?.(folder) ?? false;
          const rowIndex = windowRows.first + windowIndex;
          const cover = coverFor(folder.id);
          const coverBlurred = cover ? blurredImages.has(cover.relPath) : false;
          return (
            <li
              key={folder.id}
              style={{ position: 'absolute', left: 0, right: 0, top: rowIndex * FOLDER_TREE_ROW_HEIGHT, height: FOLDER_TREE_ROW_HEIGHT }}
              role="treeitem"
              aria-level={depth + 1}
              aria-posinset={positionInSet}
              aria-setsize={setSize}
              aria-selected={active}
              aria-expanded={hasChildren ? expanded : undefined}
              aria-disabled={disabled || undefined}
            >
              <div
                className={`dk-tree-row ${active ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
                style={{ paddingLeft: 4 + depth * 14 }}
                onContextMenu={onFolderContextMenu ? (event) => onFolderContextMenu(event, folder) : undefined}
              >
                <button
                  type="button"
                  className={`dk-car ${expanded ? 'open' : ''}`}
                  style={hasChildren ? undefined : { visibility: 'hidden' }}
                  tabIndex={hasChildren ? 0 : -1}
                  aria-label={hasChildren ? `${expanded ? '收起' : '展开'} ${folder.name}` : undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (hasChildren) onToggleFolder(folder.id);
                  }}
                >
                  <CaretRight size={11} weight="bold" />
                </button>
                <button
                  type="button"
                  className="dk-go"
                  disabled={disabled}
                  aria-label={`${folder.name}，${formatCount(folder.imageCount)} 张图片`}
                  aria-current={!pick && active ? 'page' : undefined}
                  onClick={() => (pick?.onPick ? pick.onPick(folder) : onSelect(folder))}
                >
                  <span className="dk-mt">
                    {cover && <BlobImage store={store} fileRef={imageFileRef(cover)} alt="" className="dk-art" thumbnail lazy blur={coverBlurred} />}
                  </span>
                  <span className="dk-nm">{folder.name}</span>
                  {freshFolders?.has(folder.id) && <span className="dk-new" title="新导入" />}
                  <span className="dk-n num">{formatCount(folder.imageCount)}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

export function Sidebar({
  width,
  onResize,
  overlay,
  snapshot,
  store,
  isRoot,
  filter,
  counts,
  selectedFolderId,
  expandedFolders,
  onToggleFolder,
  onSelectFolder,
  onSelectFilter,
  onFolderContextMenu,
  onRootContextMenu,
  onNewFolder,
  onOpenSettings,
  coverFor,
  blurredImages,
  freshFolders,
  libraryBytes,
  imageCount,
}: {
  width: number;
  onResize: (width: number) => void;
  /** 窄窗口：侧栏浮在内容之上。 */
  overlay: boolean;
  snapshot: LibrarySnapshot | null;
  store: LibraryStore;
  isRoot: boolean;
  filter: LibraryFilter;
  counts: Record<LibraryFilter, number>;
  selectedFolderId: string;
  expandedFolders: ReadonlySet<string>;
  onToggleFolder: (id: string) => void;
  onSelectFolder: (folder: FolderNode) => void;
  onSelectFilter: (filter: LibraryFilter) => void;
  onFolderContextMenu: (event: ReactMouseEvent, folder: FolderNode) => void;
  onRootContextMenu: (event: ReactMouseEvent) => void;
  onNewFolder: () => void;
  onOpenSettings: () => void;
  coverFor: (folderId: string) => ImageEntry | null;
  blurredImages: ReadonlySet<string>;
  freshFolders: ReadonlySet<string>;
  libraryBytes: number;
  imageCount: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nav = (value: LibraryFilter, label: string, Icon: typeof Clock) => (
    <button
      type="button"
      className={`dk-nav-i ${isRoot && filter === value ? 'on' : ''}`}
      aria-current={isRoot && filter === value ? 'page' : undefined}
      onClick={() => onSelectFilter(value)}
      onContextMenu={value === 'all' ? onRootContextMenu : undefined}
    >
      <Icon size={17} weight={value === 'all' ? 'duotone' : 'regular'} />
      <span>{label}</span>
      <span className="dk-n num">{formatCount(counts[value])}</span>
    </button>
  );
  const hasPacks = counts.all > 0;
  return (
    <aside className={`dk-side ${overlay ? 'overlay' : ''}`} style={{ width }} aria-label="图包导航">
      <SidebarResizeHandle width={width} onResize={onResize} max={360} />
      <div ref={scrollRef} className="dk-side-scroll dk-scroll">
        {nav('all', '全部图包', ImagesSquare)}
        {nav('recent', '最近导入', Clock)}
        {nav('pinned', '已固定封面', PushPin)}
        <div className="dk-lbl">
          <span>图包目录</span>
          <button type="button" className="dk-ib" title="新建图包" aria-label="新建图包" onClick={onNewFolder}>
            <Plus size={13} />
          </button>
        </div>
        {snapshot && hasPacks ? (
          <FolderTree
            snapshot={snapshot}
            selectedFolderId={selectedFolderId}
            onSelect={onSelectFolder}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onFolderContextMenu={onFolderContextMenu}
            scrollRootRef={scrollRef}
            store={store}
            coverFor={coverFor}
            blurredImages={blurredImages}
            freshFolders={freshFolders}
          />
        ) : (
          <div className="dk-tree-tip">导入后，图包会按原目录结构出现在这里。</div>
        )}
      </div>
      <div className="dk-side-foot">
        <div className="dk-store">
          <div className="dk-row"><span>图库占用</span><b className="num">{formatBytes(libraryBytes)}</b></div>
          <div className="dk-row"><span className="num">{formatCount(imageCount)} 张图片</span></div>
        </div>
        <button type="button" className="dk-nav-i" onClick={onOpenSettings}>
          <GearSix size={17} />
          <span>设置</span>
          <kbd className="dk-kbd dk-push">Ctrl ,</kbd>
        </button>
      </div>
    </aside>
  );
}
