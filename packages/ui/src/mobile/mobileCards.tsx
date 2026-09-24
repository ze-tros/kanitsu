/**
 * 移动端图库卡片与网格：图包封面卡 / 列表行、子目录卡、继续浏览卡、图片卡 / 列表行。
 * 只负责展示与手势（点按、长按），业务动作由 MobileApp 通过回调注入。
 */
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { isHeifImage, isRawImage, type FolderNode, type ImageEntry } from '../../../core/src/index';
import type { FileRef, LibraryStore } from '../../../fs-adapter/src/types';
import { BlobImage } from '../BlobImage';
import { COVER_THUMBNAIL_SIZE } from '../thumbnailCache';
import { MobileIcon } from './mobileIcons';
import { formatBytes, haptic } from './mobileShared';

export function imageToFileRef(image: ImageEntry): FileRef {
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

/** 长按手势（移动端替代右键）。带位移阈值 + 触发前按压视觉反馈；多指触摸（捏合）不计长按。 */
function useLongPress(onLongPress: () => void, ms = 460) {
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);
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
      if (e.touches.length > 1) return;
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
      if (!p || !t || e.touches.length > 1) {
        cancel();
        return;
      }
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

  // 长按触发后动作面板会滑到手指下方；手指抬起时 WebView 按释放坐标做命中
  // 测试并合成 click，落在面板按钮上就会误触发动作（“自动选中手指位置”）。
  // 在非被动监听里对已触发长按的触摸 preventDefault，阻止浏览器合成 click。
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;
    const onTouchEnd = (event: TouchEvent) => {
      if (firedRef.current) event.preventDefault();
    };
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => el.removeEventListener('touchend', onTouchEnd);
  }, []);

  return {
    ref: elementRef,
    handlers: {
      onTouchStart: start,
      onTouchMove: move,
      onTouchEnd: end,
      onTouchCancel: cancel,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
    wasLongPress: () => firedRef.current,
    /** 按压中（用于触发前的视觉反馈，替代容易误判的 active:opacity）。 */
    pressing,
  };
}

/**
 * 平铺网格/列表容器：不做窗口虚拟化（全量挂载、永不卸载，滚动是纯合成器
 * 行为，不存在“窗口追不上视口”的空白）。进大图包时为避免数百张卡片挤在
 * 首帧前一次性挂载（主线程卡几百毫秒、响应不及时），按帧分批填充：首帧只
 * 挂载一批，随后每帧补一批直到全部就位。填充单调递增、与滚动无关。
 * 列数变化（捏合）只改 grid-template-columns，不重建子节点。
 */
const ROW_FILL_BATCH = 60;

export function RowGrid<T>({
  items,
  cols,
  gap,
  className = '',
  style,
  renderItem,
  getKey,
}: {
  items: T[];
  cols: number;
  gap: number;
  className?: string;
  style?: CSSProperties;
  renderItem: (item: T, index: number) => ReactNode;
  getKey: (item: T) => string;
}) {
  const [fill, setFill] = useState({ items, count: ROW_FILL_BATCH });
  // 换目录/换结果集时重置填充进度（渲染期派生状态，避免闪现旧进度）。
  if (fill.items !== items) setFill({ items, count: ROW_FILL_BATCH });
  const count = fill.items === items ? fill.count : ROW_FILL_BATCH;
  useEffect(() => {
    if (count >= items.length) return;
    const raf = requestAnimationFrame(() => {
      setFill((prev) =>
        prev.items === items ? { items, count: Math.min(items.length, prev.count + ROW_FILL_BATCH) } : prev,
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [count, items]);
  if (items.length === 0 || cols <= 0) return null;
  return (
    <div className={className} style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap, ...style }}>
      {items.slice(0, Math.min(count, items.length)).map((item, index) => (
        <Fragment key={getKey(item)}>{renderItem(item, index)}</Fragment>
      ))}
    </div>
  );
}

function CoverImage({
  image,
  store,
  alt,
  blurred,
  pinned = false,
  className = 'w-full h-full object-cover',
}: {
  image: ImageEntry | undefined;
  store: LibraryStore;
  alt: string;
  blurred: boolean;
  pinned?: boolean;
  className?: string;
}) {
  if (!image) {
    return (
      <div className="m2-placeholder" aria-hidden="true">
        <MobileIcon name="folder" className="w-8 h-8" />
      </div>
    );
  }
  return (
    <BlobImage
      store={store}
      fileRef={imageToFileRef(image)}
      alt={alt}
      className={className}
      thumbnail
      thumbnailSize={pinned ? COVER_THUMBNAIL_SIZE : undefined}
      lazy
      blur={blurred}
    />
  );
}

/** 图包封面卡：竖版封面 + 张数角标 + 固定封面标记，下方名称与副标题。 */
export function PackCard({
  folder,
  cover,
  store,
  pinned,
  blurred,
  subtitle,
  onOpen,
  onActions,
}: {
  folder: FolderNode;
  cover: ImageEntry | undefined;
  store: LibraryStore;
  pinned: boolean;
  blurred: boolean;
  subtitle: string;
  onOpen: () => void;
  onActions: () => void;
}) {
  const lp = useLongPress(onActions);
  return (
    <div
      ref={lp.ref}
      className={`m2-pack ${lp.pressing ? 'is-pressing' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${folder.name}，${folder.imageCount} 张`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      {...lp.handlers}
      onClick={() => {
        if (!lp.wasLongPress()) onOpen();
      }}
    >
      <div className="m2-pack-cover">
        <CoverImage image={cover} store={store} alt={folder.name} blurred={blurred} pinned={pinned} />
        {pinned && (
          <span className="m2-badge is-tl" aria-label="已固定封面">
            <MobileIcon name="pin" className="w-3.5 h-3.5" />
          </span>
        )}
        <span className="m2-badge is-br tabular-nums">
          <MobileIcon name="image" className="w-3.5 h-3.5" />
          {folder.imageCount}
        </span>
      </div>
      <div className="m2-pack-name">{folder.name}</div>
      {subtitle && <div className="m2-pack-sub">{subtitle}</div>}
    </div>
  );
}

/** 图包列表行。 */
export function PackRow({
  folder,
  cover,
  store,
  pinned,
  blurred,
  subtitle,
  onOpen,
  onActions,
}: {
  folder: FolderNode;
  cover: ImageEntry | undefined;
  store: LibraryStore;
  pinned: boolean;
  blurred: boolean;
  subtitle: string;
  onOpen: () => void;
  onActions?: () => void;
}) {
  const lp = useLongPress(() => onActions?.());
  return (
    <div
      ref={lp.ref}
      className={`m2-pack-row ${lp.pressing ? 'is-pressing' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={folder.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      {...lp.handlers}
      onClick={() => {
        if (!lp.wasLongPress()) onOpen();
      }}
    >
      <div className="m2-pack-row-thumb">
        <CoverImage image={cover} store={store} alt={folder.name} blurred={blurred} pinned={pinned} />
      </div>
      <div className="m2-pack-row-body">
        <strong>{folder.name}</strong>
        <small className="tabular-nums">{subtitle}</small>
      </div>
      {pinned && <MobileIcon name="pin" className="w-4 h-4 m2-muted shrink-0" />}
      <MobileIcon name="chevron-right" className="w-4 h-4 m2-muted shrink-0" />
    </div>
  );
}

/** 图包页顶部横向子目录卡。 */
export function SubfolderCard({
  folder,
  cover,
  store,
  pinned,
  blurred,
  onOpen,
  onActions,
}: {
  folder: FolderNode;
  cover: ImageEntry | undefined;
  store: LibraryStore;
  pinned: boolean;
  blurred: boolean;
  onOpen: () => void;
  onActions: () => void;
}) {
  const lp = useLongPress(onActions);
  return (
    <div
      ref={lp.ref}
      className={`m2-subfolder ${lp.pressing ? 'is-pressing' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${folder.name}，${folder.imageCount} 张`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      {...lp.handlers}
      onClick={() => {
        if (!lp.wasLongPress()) onOpen();
      }}
    >
      <div className="m2-subfolder-thumb">
        <CoverImage image={cover} store={store} alt={folder.name} blurred={blurred} pinned={pinned} />
      </div>
      <strong>{folder.name}</strong>
      <small className="tabular-nums">
        {folder.imageCount} 张{folder.childCount > 0 ? ` · ${folder.childCount} 个子目录` : ''}
      </small>
    </div>
  );
}

/** 继续浏览卡：上次停留的图片 + 进度。 */
export function ContinueCard({
  folder,
  image,
  position,
  total,
  store,
  blurred,
  onOpen,
}: {
  folder: FolderNode;
  image: ImageEntry;
  position: number;
  total: number;
  store: LibraryStore;
  blurred: boolean;
  onOpen: () => void;
}) {
  return (
    <button className="m2-continue-card" onClick={onOpen} aria-label={`继续浏览 ${folder.name}，第 ${position + 1} 张，共 ${total} 张`}>
      <div className="m2-continue-thumb">
        <CoverImage image={image} store={store} alt="" blurred={blurred} />
      </div>
      <span className="m2-continue-body">
        <strong>{folder.name}</strong>
        <small className="tabular-nums">
          看到 {position + 1} / {total}
        </small>
        <span className="m2-progress-line" aria-hidden="true">
          <i style={{ width: `${Math.max(2, ((position + 1) / total) * 100)}%` }} />
        </span>
      </span>
    </button>
  );
}

/** 网格卡片的格式角标：RAW / HEIC / 长图。 */
function formatTag(image: ImageEntry): string | null {
  if (isRawImage(image.name)) return 'RAW';
  if (isHeifImage(image.name)) return 'HEIC';
  if (image.width && image.height && image.height / image.width > 3) return '长图';
  return null;
}

function SelectCheck({ selected }: { selected: boolean }) {
  return (
    <span className={`m2-check ${selected ? 'is-on' : ''}`} aria-hidden="true">
      {selected && <MobileIcon name="check" className="w-3.5 h-3.5" />}
    </span>
  );
}

interface ImageItemProps {
  image: ImageEntry;
  index: number;
  store: LibraryStore;
  blurred: boolean;
  selectMode: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: (id: string) => void;
  /** 长按：进入多选（已在多选中则选中该项）并开始拖动连选。 */
  onLongPress: (image: ImageEntry, index: number) => void;
}

function useImageItemGesture({ image, index, selectMode, onOpen, onToggleSelect, onLongPress }: ImageItemProps) {
  const lp = useLongPress(() => onLongPress(image, index));
  const activate = () => {
    if (lp.wasLongPress()) return;
    if (selectMode) onToggleSelect(image.id);
    else onOpen();
  };
  return { lp, activate };
}

/** 图片卡片（方形，圆角卡片风格）。data-grid-index 供拖动连选做命中测试。 */
export function ImageCard(props: ImageItemProps & { showName: boolean }) {
  const { image, index, store, blurred, selectMode, selected, showName } = props;
  const { lp, activate } = useImageItemGesture(props);
  const tag = formatTag(image);
  return (
    <div
      ref={lp.ref}
      className={`m2-cell ${selected ? 'is-selected' : ''} ${lp.pressing ? 'is-pressing' : ''}`}
      data-grid-index={index}
      role="button"
      tabIndex={0}
      aria-pressed={selectMode ? selected : undefined}
      aria-label={selectMode ? (selected ? `已选择 ${image.name}` : `选择 ${image.name}`) : image.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      {...lp.handlers}
      onClick={activate}
    >
      {/* 全量挂载后缩略图必须走 IntersectionObserver 懒加载，否则进目录即发起数百个并发读取请求。 */}
      <BlobImage store={store} fileRef={imageToFileRef(image)} alt={image.name} className="m2-cell-img" thumbnail lazy blur={blurred} />
      {blurred && (
        <span className="m2-cell-blur" aria-hidden="true">
          <MobileIcon name="eye-off" className="w-4 h-4" />
        </span>
      )}
      {tag && <span className="m2-cell-tag">{tag}</span>}
      {showName && <span className="m2-cell-name">{image.name}</span>}
      {selectMode && <SelectCheck selected={selected} />}
    </div>
  );
}

/** 列表视图行（缩略图 + 名称 + 尺寸）。 */
export function ImageListRow(props: ImageItemProps) {
  const { image, index, store, blurred, selectMode, selected } = props;
  const { lp, activate } = useImageItemGesture(props);
  const meta = [image.width && image.height ? `${image.width}×${image.height}` : '', image.size ? formatBytes(image.size) : '', formatTag(image) ?? '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      ref={lp.ref}
      className={`m2-image-row ${selected ? 'is-selected' : ''} ${lp.pressing ? 'is-pressing' : ''}`}
      data-grid-index={index}
      role="button"
      tabIndex={0}
      aria-pressed={selectMode ? selected : undefined}
      aria-label={selectMode ? (selected ? `已选择 ${image.name}` : `选择 ${image.name}`) : image.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      {...lp.handlers}
      onClick={activate}
    >
      <div className="m2-image-row-thumb">
        <BlobImage store={store} fileRef={imageToFileRef(image)} alt={image.name} className="w-full h-full object-cover" thumbnail lazy blur={blurred} />
      </div>
      <div className="m2-image-row-body">
        <strong>{image.name}</strong>
        {meta && <small className="tabular-nums">{meta}</small>}
      </div>
      {selectMode && <SelectCheck selected={selected} />}
    </div>
  );
}
