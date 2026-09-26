/**
 * 桌面检查器：按上下文切换
 * - 图包 / 图库概览：封面、统计、可整理提示、格式分布、状态；
 * - 单张图片：预览、快捷动作、拍摄信息（EXIF 四格摘要 + 全部标签）、文件信息；
 * - 多选：叠图预览与汇总。批量动作只在底部浮动栏出现，这里不重复。
 */
import { useMemo } from 'react';
import {
  Aperture,
  ArrowsOut,
  CaretRight,
  Copy,
  DotsThree,
  Eye,
  EyeSlash,
  FolderPlus,
  ImagesSquare,
  MagicWand,
  PencilSimple,
  PushPin,
  SidebarSimple,
  Sparkle,
  Trash,
  X,
  CheckSquare,
} from '@phosphor-icons/react';
import type { FolderNode, ImageEntry } from '../../../core/src/index';
import type { LibraryStore } from '../../../fs-adapter/src/types';
import { BlobImage } from '../BlobImage';
import { ExifFieldList, useExifInfo, type ExifState } from '../exifInfo';
import { COVER_THUMBNAIL_SIZE } from '../thumbnailCache';
import { extLabel, formatBytes, formatCount, formatModifiedTime, imageFileRef } from './shared';

const FORMAT_COLORS: Record<string, string> = {
  JPG: 'var(--desktop-accent-fill)',
  PNG: '#8aa4e8',
  WEBP: '#c2c9d0',
  GIF: '#c792ea',
  HEIC: '#7fcf9a',
  HEIF: '#7fcf9a',
  HIF: '#7fcf9a',
  AVIF: '#5fb3b3',
  BMP: '#b58d6a',
};
const RAW_COLOR = '#e2ad55';

function FormatBar({ images }: { images: readonly ImageEntry[] }) {
  const entries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const image of images) {
      const key = extLabel(image);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [images]);
  if (entries.length === 0) return <div className="dk-tip">暂无文件</div>;
  const total = images.length;
  // 未列出的扩展名都是相机 RAW（支持格式之外的文件不会进图库）。
  const color = (key: string) => FORMAT_COLORS[key] ?? RAW_COLOR;
  return (
    <>
      <div className="dk-fmt-bar" aria-hidden="true">
        {entries.map(([key, n]) => <i key={key} style={{ width: `${(n / total) * 100}%`, background: color(key) }} />)}
      </div>
      <div className="dk-legend">
        {entries.slice(0, 8).map(([key, n]) => (
          <span key={key}><i style={{ background: color(key) }} />{key}<b className="num">{formatCount(n)}</b></span>
        ))}
      </div>
    </>
  );
}

/** 拍摄信息：相机 / 镜头一行 + 焦距 / 光圈 / 快门 / ISO 四格，其余进「全部标签」。 */
export function ExifSummary({ state }: { state: ExifState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'loading') return <div className="dk-exif-cam dk-muted-row">读取中…</div>;
  if (state.rows.length === 0) return <div className="dk-exif-cam dk-muted-row">无 EXIF 信息</div>;
  const get = (label: string) => state.rows.find((row) => row.label === label)?.value;
  const camera = get('相机');
  const lens = get('镜头');
  const hero = ['焦距', '光圈', '快门', 'ISO']
    .map((label) => {
      const value = get(label);
      if (!value) return null;
      if (label === '焦距') {
        const eq = value.match(/等效\s*([\d.]+)\s*mm/);
        return eq ? { label: '等效焦距', value: `${eq[1]}mm` } : { label, value: value.replace(/\s+mm/, 'mm') };
      }
      return { label: label === 'ISO' ? '感光度' : label, value: label === 'ISO' ? `ISO ${value.replace(/^ISO\s*/, '')}` : value };
    })
    .filter((cell): cell is { label: string; value: string } => cell != null);
  const shown = new Set(['相机', '镜头', ...(hero.length ? ['焦距', '光圈', '快门', 'ISO'] : [])]);
  const rest = state.rows.filter((row) => !shown.has(row.label));
  return (
    <>
      {(camera || lens) && (
        <div className="dk-exif-cam">
          <Aperture size={22} />
          <div className="dk-shrink">
            <b>{camera ?? '未知相机'}</b>
            {lens && <small>{lens}</small>}
          </div>
        </div>
      )}
      {hero.length > 0 && (
        <div className="dk-exif4">
          {hero.map((cell) => (
            <div key={cell.label}><span>{cell.label}</span><b title={cell.value}>{cell.value}</b></div>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div className="dk-kv spaced">
          {rest.map((row) => (
            <FragmentRow key={row.label} label={row.label} value={row.value} />
          ))}
        </div>
      )}
      {state.fields.length > 0 && (
        <details className="dk-more-exif">
          <summary><CaretRight size={11} weight="bold" />全部 EXIF 标签（{state.fields.length}）</summary>
          <div className="dk-exif-all"><ExifFieldList fields={state.fields} /></div>
        </details>
      )}
    </>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span>{label}</span>
      <b title={value}>{value}</b>
    </>
  );
}

export interface OrganizeHint {
  ruleId: string;
  ruleName: string;
  moved: number;
  groups: number;
}

function Head({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="dk-insp-h">
      <span>{title}</span>
      <button type="button" className="dk-ib" title="收起检查器 (Ctrl+I)" aria-label="收起检查器" onClick={onClose}>
        <SidebarSimple size={16} mirrored />
      </button>
    </div>
  );
}

export function Inspector({
  store,
  overlay,
  folder,
  isRoot,
  folderImages,
  childFolderCount,
  cover,
  coverPinned,
  importedLabel,
  selectedImages,
  selectedFolders,
  selectedFolderCovers,
  selectedFolderStats,
  blurredImages,
  pinnedCovers,
  organizeHint,
  busy,
  onClose,
  onOpenImage,
  onToggleImageBlur,
  onPinImage,
  onRenameImage,
  onImageMenu,
  onViewSelection,
  onSelectAll,
  onClearSelection,
  onOrganize,
  onCreateFolder,
  onRenameFolder,
  onCopyFolderPath,
  onDeleteFolder,
}: {
  store: LibraryStore;
  overlay: boolean;
  folder: FolderNode | null;
  isRoot: boolean;
  /** 当前图包（含子目录）的全部图片；根目录为全库。 */
  folderImages: readonly ImageEntry[];
  childFolderCount: number;
  cover: ImageEntry | null;
  coverPinned: boolean;
  importedLabel?: string;
  selectedImages: readonly ImageEntry[];
  selectedFolders: readonly FolderNode[];
  selectedFolderCovers: readonly ImageEntry[];
  selectedFolderStats: { images: number; bytes: number; childFolders: number };
  blurredImages: ReadonlySet<string>;
  pinnedCovers: Record<string, string>;
  organizeHint: OrganizeHint | null;
  busy: boolean;
  onClose: () => void;
  onOpenImage: (image: ImageEntry) => void;
  onToggleImageBlur: (image: ImageEntry) => void;
  onPinImage: (image: ImageEntry) => void;
  onRenameImage: (image: ImageEntry) => void;
  onImageMenu: (image: ImageEntry, anchor: HTMLElement) => void;
  onViewSelection: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onOrganize: () => void;
  onCreateFolder: () => void;
  onRenameFolder: () => void;
  onCopyFolderPath: () => void;
  onDeleteFolder: () => void;
}) {
  const single = selectedImages.length === 1 && selectedFolders.length === 0 ? selectedImages[0]! : null;
  const exif = useExifInfo(store, single, single != null);
  const cls = overlay ? 'dk-insp overlay' : 'dk-insp';
  const selectionCount = selectedImages.length + selectedFolders.length;

  if (single) {
    const blurred = blurredImages.has(single.relPath);
    const pinned = pinnedCovers[single.folderId] === single.id;
    const aspect = single.width && single.height ? Math.max(0.6, single.width / single.height) : 1;
    return (
      <aside className={cls} aria-label="图片信息">
        <Head title="图片信息" onClose={onClose} />
        <div className="dk-insp-b dk-scroll">
          <div className="dk-pv" style={{ aspectRatio: String(aspect) }}>
            <BlobImage store={store} fileRef={imageFileRef(single)} alt={single.name} className="dk-art" thumbnail blur={blurred} />
          </div>
          <h3>
            <button type="button" title="重命名 (F2)" onClick={() => onRenameImage(single)}>{single.name}</button>
          </h3>
          <div className="dk-sub num">
            {single.width && single.height ? `${single.width} × ${single.height} · ` : ''}
            {formatBytes(single.size)} · {extLabel(single)}
          </div>
          <div className="dk-qa">
            <button type="button" onClick={() => onOpenImage(single)}><ArrowsOut size={16} />打开</button>
            <button type="button" className={pinned ? 'on' : ''} onClick={() => onPinImage(single)}><PushPin size={16} />{pinned ? '取消封面' : '设为封面'}</button>
            <button type="button" className={blurred ? 'on' : ''} onClick={() => onToggleImageBlur(single)}>
              {blurred ? <Eye size={16} /> : <EyeSlash size={16} />}{blurred ? '取消遮挡' : '隐私预览'}
            </button>
            <button type="button" onClick={(event) => onImageMenu(single, event.currentTarget)}><DotsThree size={16} weight="bold" />更多</button>
          </div>
          <section>
            <h4>拍摄信息</h4>
            <ExifSummary state={exif} />
          </section>
          <section>
            <h4>文件</h4>
            <div className="dk-kv">
              <span>修改时间</span><b className="num">{formatModifiedTime(single.mtime)}</b>
              <span>库内路径</span><b className="path">{single.relPath}</b>
            </div>
          </section>
        </div>
      </aside>
    );
  }

  if (selectionCount > 1 || (selectedFolders.length === 1 && selectedImages.length > 0)) {
    const previews = [...selectedImages.slice(0, 3), ...selectedFolderCovers].slice(0, 3);
    const bytes = selectedImages.reduce((sum, image) => sum + image.size, 0) + selectedFolderStats.bytes;
    const title = [
      selectedImages.length ? `${formatCount(selectedImages.length)} 张图片` : '',
      selectedFolders.length ? `${formatCount(selectedFolders.length)} 个图包` : '',
    ].filter(Boolean).join(' · ');
    return (
      <aside className={cls} aria-label="已选择">
        <Head title="已选择" onClose={onClose} />
        <div className="dk-insp-b dk-scroll">
          <div className="dk-stackpv" aria-hidden="true">
            {previews.slice().reverse().map((image, i, arr) => {
              const offset = i - (arr.length - 1) / 2;
              return (
                <span key={image.id} style={{ transform: `translateX(${offset * 26}px) rotate(${offset * 6}deg)` }}>
                  <BlobImage store={store} fileRef={imageFileRef(image)} alt="" className="dk-art" thumbnail lazy blur={blurredImages.has(image.relPath)} />
                </span>
              );
            })}
          </div>
          <h3 className="center">{title}</h3>
          <div className="dk-sub num center">
            共 {formatBytes(bytes)}
            {selectedFolders.length > 0 ? ` · 含 ${formatCount(selectedFolderStats.images)} 张图片` : ''}
          </div>
          {selectedImages.length > 0 && (
            <section>
              <h4>格式</h4>
              <FormatBar images={selectedImages} />
            </section>
          )}
          <section>
            <h4>操作</h4>
            <div className="dk-tip dk-sel-tip">批量操作在底部浮动栏。</div>
            {selectedImages.length > 1 && selectedFolders.length === 0 && (
              <button type="button" className="dk-rowact" onClick={onViewSelection}><ArrowsOut size={16} />在查看器中逐张浏览<kbd className="dk-kbd">Enter</kbd></button>
            )}
            <button type="button" className="dk-rowact" onClick={onSelectAll}><CheckSquare size={16} />全选当前结果<kbd className="dk-kbd">Ctrl A</kbd></button>
            <button type="button" className="dk-rowact" onClick={onClearSelection}><X size={16} />取消选择<kbd className="dk-kbd">Esc</kbd></button>
          </section>
        </div>
      </aside>
    );
  }

  // 图包 / 图库概览（单选一个图包时展示该图包）。
  const target = selectedFolders.length === 1 ? selectedFolders[0]! : folder;
  const showRoot = isRoot && selectedFolders.length === 0;
  const blurredCount = folderImages.reduce((n, image) => n + (blurredImages.has(image.relPath) ? 1 : 0), 0);
  const bytes = folderImages.reduce((sum, image) => sum + image.size, 0);
  const latest = folderImages.reduce((value, image) => Math.max(value, image.mtime), 0);
  const coverBlurred = cover ? blurredImages.has(cover.relPath) : false;
  return (
    <aside className={cls} aria-label={showRoot ? '图库概览' : '图包信息'}>
      <Head title={showRoot ? '图库概览' : '图包'} onClose={onClose} />
      <div className="dk-insp-b dk-scroll">
        {!showRoot && target && (
          <>
            <div className="dk-pv sq">
              {cover ? (
                <BlobImage store={store} fileRef={imageFileRef(cover)} alt="" className="dk-art" thumbnail thumbnailSize={coverPinned ? COVER_THUMBNAIL_SIZE : undefined} lazy blur={coverBlurred} />
              ) : (
                <span className="dk-cover-empty"><ImagesSquare size={30} weight="duotone" /></span>
              )}
              {cover && (
                <span className="dk-badge tl">
                  {coverPinned ? <PushPin size={11} weight="fill" /> : <Sparkle size={11} weight="fill" />}
                  {coverPinned ? '固定封面' : '智能封面'}
                </span>
              )}
            </div>
            <h3>{target.name}</h3>
            <div className="dk-sub">{importedLabel ? `导入于 ${importedLabel}` : '图包'}</div>
          </>
        )}
        <div className="dk-stats3">
          <div><b className="num">{formatCount(folderImages.length)}</b><span>图片</span></div>
          <div><b className="num">{formatCount(childFolderCount)}</b><span>{showRoot ? '图包' : '子图包'}</span></div>
          <div><b className="num">{formatBytes(bytes)}</b><span>占用</span></div>
        </div>
        {!showRoot && organizeHint && (
          <div className="dk-callout">
            <b><MagicWand size={16} />可按「{organizeHint.ruleName}」整理</b>
            <p>{formatCount(organizeHint.moved)} 张图片可以分进 {organizeHint.groups} 个子图包。先预览，确认后才会移动。</p>
            <button type="button" className="dk-btn sm primary" disabled={busy} onClick={onOrganize}>预览整理方案</button>
          </div>
        )}
        <section>
          <h4>格式分布</h4>
          <FormatBar images={folderImages} />
        </section>
        <section>
          <h4>状态</h4>
          <div className="dk-kv">
            <span>隐私预览</span><b className="num">{formatCount(blurredCount)} 张</b>
            <span>最近修改</span><b className="num">{latest ? formatModifiedTime(latest) : '—'}</b>
            {!showRoot && target && (<><span>库内路径</span><b className="path">{target.relPath}</b></>)}
          </div>
        </section>
        {!showRoot && target && (
          <section>
            <h4>操作</h4>
            <button type="button" className="dk-rowact" disabled={busy} onClick={onCreateFolder}><FolderPlus size={16} />新建子图包</button>
            <button type="button" className="dk-rowact" disabled={busy} onClick={onRenameFolder}><PencilSimple size={16} />重命名<kbd className="dk-kbd">F2</kbd></button>
            <button type="button" className="dk-rowact" onClick={onCopyFolderPath}><Copy size={16} />复制库内路径</button>
            <button type="button" className="dk-rowact danger" disabled={busy} onClick={onDeleteFolder}><Trash size={16} />删除图包</button>
          </section>
        )}
      </div>
    </aside>
  );
}
