/**
 * 浏览相关的底部面板：图包页「显示」选项、图库「图包排列」、目录树。
 * 选项即时生效（面板不关），目录树点选后收起面板再导航。
 */
import { childrenOf, type LibrarySnapshot } from '../../../core/src/index';
import { MobileIcon, type MobileIconName } from './mobileIcons';
import { MobileBottomSheet } from './MobileSheets';
import { IMAGE_GRID, LIBRARY_SORT_LABELS, type LibraryPrefs, type LibrarySort } from './mobileShared';

export type SortMode = 'default' | 'name' | 'date' | 'size';
export type SortDirection = 'asc' | 'desc';

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, string, MobileIconName?]>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="m2-segmented" role="radiogroup" aria-label={label}>
      {options.map(([v, text, icon]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'is-on' : ''} onClick={() => onChange(v)}>
          {icon && <MobileIcon name={icon} className="w-4 h-4" />}
          {text}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className={`m2-switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span aria-hidden="true" />
    </button>
  );
}

export function DisplaySheet({
  viewMode,
  onViewMode,
  cols,
  onCols,
  sortMode,
  onSortMode,
  sortDirection,
  onSortDirection,
  showFileNames,
  onShowFileNames,
  aggregate,
  onAggregate,
  childCount,
  onClose,
}: {
  viewMode: 'grid' | 'list';
  onViewMode: (mode: 'grid' | 'list') => void;
  cols: number;
  onCols: (cols: number) => void;
  sortMode: SortMode;
  onSortMode: (mode: SortMode) => void;
  sortDirection: SortDirection;
  onSortDirection: (dir: SortDirection) => void;
  showFileNames: boolean;
  onShowFileNames: (value: boolean) => void;
  aggregate: boolean;
  onAggregate: (value: boolean) => void;
  childCount: number;
  onClose: () => void;
}) {
  return (
    <MobileBottomSheet title="显示" subtitle="只影响本机的浏览方式" onClose={onClose}>
      <div className="m2-opt-group">
        <h4>布局</h4>
        <Segmented
          label="布局"
          value={viewMode}
          onChange={onViewMode}
          options={[
            ['grid', '网格', 'grid'],
            ['list', '列表', 'list'],
          ]}
        />
      </div>
      {viewMode === 'grid' && (
        <div className="m2-opt-group">
          <h4>
            每行 <b className="tabular-nums">{cols}</b> 张 · 也可在网格上双指捏合
          </h4>
          <div className="m2-density">
            <MobileIcon name="grid" className="w-4 h-4" />
            <input
              type="range"
              min={IMAGE_GRID.minCols}
              max={IMAGE_GRID.maxCols}
              step={1}
              value={cols}
              aria-label="每行图片数"
              onChange={(e) => onCols(Number(e.target.value))}
            />
            <span className="tabular-nums">{IMAGE_GRID.maxCols}</span>
          </div>
        </div>
      )}
      <div className="m2-opt-group">
        <h4>排序</h4>
        <Segmented
          label="排序方式"
          value={sortMode}
          onChange={(mode) => {
            onSortMode(mode);
            // 名称默认升序；日期/大小默认最新/最大在前（与原排序选择器一致）。
            if (mode === 'name') onSortDirection('asc');
            else if (mode === 'date' || mode === 'size') onSortDirection('desc');
          }}
          options={[
            ['default', '默认'],
            ['name', '名称'],
            ['date', '日期'],
            ['size', '大小'],
          ]}
        />
        {sortMode !== 'default' && (
          <div className="mt-2">
            <Segmented
              label="排序方向"
              value={sortDirection}
              onChange={onSortDirection}
              options={[
                ['asc', '升序'],
                ['desc', '降序'],
              ]}
            />
          </div>
        )}
      </div>
      <div className="m2-opt-group">
        <div className="m2-opt-row">
          <span>
            <strong>显示文件名</strong>
            <small>网格下在缩略图底部显示</small>
          </span>
          <Switch checked={showFileNames} onChange={onShowFileNames} label="显示文件名" />
        </div>
        {childCount > 0 && (
          <div className="m2-opt-row">
            <span>
              <strong>包含子目录图片</strong>
              <small>把 {childCount} 个子目录的图片一起平铺</small>
            </span>
            <Switch checked={aggregate} onChange={onAggregate} label="包含子目录图片" />
          </div>
        )}
      </div>
    </MobileBottomSheet>
  );
}

export function LibrarySortSheet({ prefs, onChange, onClose }: { prefs: LibraryPrefs; onChange: (prefs: LibraryPrefs) => void; onClose: () => void }) {
  return (
    <MobileBottomSheet title="图包排列" onClose={onClose}>
      <div className="m2-opt-group">
        <h4>排序</h4>
        <Segmented<LibrarySort>
          label="图包排序"
          value={prefs.sort}
          onChange={(sort) => onChange({ ...prefs, sort })}
          options={(Object.keys(LIBRARY_SORT_LABELS) as LibrarySort[]).map((k) => [k, LIBRARY_SORT_LABELS[k]] as const)}
        />
      </div>
      <div className="m2-opt-group">
        <h4>布局</h4>
        <Segmented
          label="图包布局"
          value={prefs.view}
          onChange={(view) => onChange({ ...prefs, view })}
          options={[
            ['grid', '封面', 'grid'],
            ['list', '列表', 'list'],
          ]}
        />
      </div>
      {prefs.view === 'grid' && (
        <div className="m2-opt-group">
          <h4>每行</h4>
          <Segmented
            label="每行图包数"
            value={String(prefs.cols) as '2' | '3'}
            onChange={(v) => onChange({ ...prefs, cols: v === '3' ? 3 : 2 })}
            options={[
              ['2', '2 个'],
              ['3', '3 个'],
            ]}
          />
        </div>
      )}
    </MobileBottomSheet>
  );
}

function TreeNodes({
  snapshot,
  folderId,
  currentFolderId,
  expanded,
  depth,
  onToggle,
  onSelect,
}: {
  snapshot: LibrarySnapshot;
  folderId: string;
  currentFolderId: string;
  expanded: ReadonlySet<string>;
  depth: number;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const children = childrenOf(snapshot, folderId).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  return (
    <>
      {children.map((folder) => {
        const open = expanded.has(folder.id);
        const hasChildren = folder.childCount > 0;
        return (
          <div key={folder.id} role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-selected={folder.id === currentFolderId}>
            <div className={`m2-tree-row ${folder.id === currentFolderId ? 'is-current' : ''}`} style={{ paddingLeft: depth * 18 }}>
              <button
                className={`m2-tree-toggle ${open ? 'is-open' : ''}`}
                disabled={!hasChildren}
                style={hasChildren ? undefined : { visibility: 'hidden' }}
                onClick={() => onToggle(folder.id)}
                aria-label={open ? `收起 ${folder.name}` : `展开 ${folder.name}`}
              >
                <MobileIcon name="chevron-right" className="w-4 h-4" />
              </button>
              <button className="m2-tree-link" onClick={() => onSelect(folder.id)}>
                <MobileIcon name="folder" className="w-[18px] h-[18px] shrink-0" />
                <span className="truncate">{folder.name}</span>
              </button>
              <small className="tabular-nums">{folder.imageCount}</small>
            </div>
            {hasChildren && open && (
              <TreeNodes
                snapshot={snapshot}
                folderId={folder.id}
                currentFolderId={currentFolderId}
                expanded={expanded}
                depth={depth + 1}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function FolderTreeSheet({
  snapshot,
  currentFolderId,
  expanded,
  refreshing,
  onToggle,
  onSelect,
  onRefresh,
  onClose,
}: {
  snapshot: LibrarySnapshot;
  currentFolderId: string;
  expanded: ReadonlySet<string>;
  refreshing: boolean;
  onToggle: (id: string) => void;
  /** 选中目录（收起面板动画结束后再导航）。 */
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const root = snapshot.folders[snapshot.rootId];
  return (
    <MobileBottomSheet
      title="目录"
      subtitle={`${root?.childCount ?? 0} 个图包 · 点名称直接跳转`}
      onClose={onClose}
      headerAction={
        <button className={`m2-icon-button ${refreshing ? 'is-spinning' : ''}`} disabled={refreshing} onClick={onRefresh} aria-label="重新扫描图库">
          <MobileIcon name="refresh" className="w-5 h-5" />
        </button>
      }
    >
      {(close) => (
        <div className="m2-tree" role="tree" aria-label="图库目录">
          <div className={`m2-tree-row ${currentFolderId === snapshot.rootId ? 'is-current' : ''}`}>
            <span className="m2-tree-toggle" aria-hidden="true">
              <MobileIcon name="images" className="w-[18px] h-[18px]" />
            </span>
            <button className="m2-tree-link" onClick={() => close(() => onSelect(snapshot.rootId))}>
              <span>全部图包</span>
            </button>
            <small className="tabular-nums">{root?.imageCount ?? 0}</small>
          </div>
          <TreeNodes
            snapshot={snapshot}
            folderId={snapshot.rootId}
            currentFolderId={currentFolderId}
            expanded={expanded}
            depth={0}
            onToggle={onToggle}
            onSelect={(id) => close(() => onSelect(id))}
          />
        </div>
      )}
    </MobileBottomSheet>
  );
}
