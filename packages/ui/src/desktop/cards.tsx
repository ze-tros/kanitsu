/**
 * 桌面图片区 / 图包区的卡片（纯展示，memo）。
 * 交互统一由外层容器按 data-* 委托处理：
 *   data-item="<key>"   整张卡片（点击 / 右键 / 框选命中）
 *   data-check          勾选框
 *   data-more           「更多」按钮（打开右键菜单）
 * 卡片自身不持有回调，滚动时只有进出窗口的卡片挂载 / 卸载。
 */
import { memo, type CSSProperties } from 'react';
import { Check, DotsThree, EyeSlash, ImageSquare, ImagesSquare, PushPin } from '@phosphor-icons/react';
import type { FolderNode, ImageEntry } from '../../../core/src/index';
import { isRawImage } from '../../../core/src/index';
import type { LibraryStore } from '../../../fs-adapter/src/types';
import { BlobImage } from '../BlobImage';
import { COVER_THUMBNAIL_SIZE } from '../thumbnailCache';
import type { ItemBox } from './galleryLayout';
import { extLabel, formatBytes, formatCount, formatModifiedTime, imageFileRef } from './shared';

/** 图包卡片封面上方的叠层装饰高度（px），计入布局的标题区。 */
export const PACK_STACK_H = 9;
/** 图包卡片名称 + 说明两行的高度（px）。 */
export const PACK_CAPTION_H = 52;
/** 图片卡片显示文件名时的标题区高度（px）。 */
export const IMAGE_CAPTION_H = 40;
export const IMAGE_LIST_ROW_H = 48;
export const PACK_LIST_ROW_H = 52;

const boxStyle = (box: ItemBox, height: number): CSSProperties => ({
  position: 'absolute',
  left: box.x,
  top: box.y,
  width: box.w,
  height,
});

const HEIC_RE = /\.(heic|heif|hif)$/i;

function imageTags(image: ImageEntry): string[] {
  const tags: string[] = [];
  if (isRawImage(image.name)) tags.push('RAW');
  else if (HEIC_RE.test(image.name)) tags.push('HEIC');
  else if (/\.gif$/i.test(image.name)) tags.push('GIF');
  if (image.width && image.height && image.height / image.width > 2.5) tags.push('长图');
  return tags;
}

export const ImageCell = memo(function ImageCell({
  image,
  box,
  rowHeight,
  store,
  selected,
  focused,
  blurred,
  showName,
  folderLabel,
  justified,
}: {
  image: ImageEntry;
  box: ItemBox;
  rowHeight: number;
  store: LibraryStore;
  selected: boolean;
  focused: boolean;
  blurred: boolean;
  showName: boolean;
  /** 含子目录浏览时标出图片所在的子图包。 */
  folderLabel?: string;
  justified: boolean;
}) {
  const tags = imageTags(image);
  return (
    <div
      className={`dk-cell ${selected ? 'sel' : ''} ${focused ? 'focus' : ''}`}
      style={boxStyle(box, rowHeight)}
      data-item={image.id}
      role="gridcell"
      aria-selected={selected}
      aria-label={image.name}
    >
      <div className="dk-thumb" style={justified ? { aspectRatio: 'auto', height: box.h } : undefined}>
        <div className="dk-fr">
          <BlobImage store={store} fileRef={imageFileRef(image)} alt={image.name} className="dk-art" thumbnail lazy blur={blurred} />
        </div>
        <span className="dk-ck" data-check role="checkbox" aria-checked={selected} aria-label={`选择${image.name}`}>
          <Check size={12} weight="bold" />
        </span>
        {tags.length > 0 && <span className="dk-tag">{tags.join(' · ')}</span>}
        {blurred && <span className="dk-lock"><EyeSlash size={16} /></span>}
      </div>
      {showName && (
        <div className="dk-cap">
          <b title={image.name}>{image.name}</b>
          <small className="num">
            {folderLabel ? `${folderLabel} · ` : ''}
            {image.width && image.height ? `${image.width} × ${image.height} · ` : ''}
            {formatBytes(image.size)}
          </small>
        </div>
      )}
    </div>
  );
});

export const ImageListRow = memo(function ImageListRow({
  image,
  box,
  store,
  selected,
  focused,
  blurred,
  folderLabel,
}: {
  image: ImageEntry;
  box: ItemBox;
  store: LibraryStore;
  selected: boolean;
  focused: boolean;
  blurred: boolean;
  folderLabel?: string;
}) {
  return (
    <div
      className={`dk-lrow ${selected ? 'sel' : ''} ${focused ? 'focus' : ''}`}
      style={boxStyle(box, box.h)}
      data-item={image.id}
      role="row"
      aria-selected={selected}
    >
      <span className="dk-cbx" data-check role="checkbox" aria-checked={selected} aria-label={`选择${image.name}`}>
        <Check size={11} weight="bold" />
      </span>
      <span className="dk-lth">
        <BlobImage store={store} fileRef={imageFileRef(image)} alt="" className="dk-art" thumbnail lazy blur={blurred} />
      </span>
      <span className="dk-lname" title={image.name}>
        {image.name}
        {folderLabel && <small>{folderLabel}</small>}
      </span>
      <span className="num">{image.width && image.height ? `${image.width} × ${image.height}` : '—'}</span>
      <span>{extLabel(image)}</span>
      <span className="num">{formatBytes(image.size)}</span>
      <span className="num">{formatModifiedTime(image.mtime)}</span>
    </div>
  );
});

export interface PackCardData {
  folder: FolderNode;
  cover: ImageEntry | null;
  /** 封面是否为用户固定的。 */
  pinned: boolean;
  bytes: number;
  /** 导入时间的相对描述（仅顶层图包、本机有记录时）。 */
  importedLabel?: string;
  fresh?: boolean;
}

export const PackCard = memo(function PackCard({
  data,
  box,
  rowHeight,
  store,
  selected,
  focused,
  coverBlurred,
}: {
  data: PackCardData;
  box: ItemBox;
  rowHeight: number;
  store: LibraryStore;
  selected: boolean;
  focused: boolean;
  coverBlurred: boolean;
}) {
  const { folder, cover, pinned } = data;
  const sub = [folder.childCount > 0 ? `${folder.childCount} 个子图包` : '', data.importedLabel ?? ''].filter(Boolean).join(' · ') || formatBytes(data.bytes);
  return (
    <div
      className={`dk-pack ${selected ? 'sel' : ''} ${focused ? 'focus' : ''}`}
      style={boxStyle(box, rowHeight)}
      data-item={`f:${folder.id}`}
      role="gridcell"
      aria-selected={selected}
      aria-label={`图包${folder.name}`}
    >
      <div className="dk-cw">
        <div className="dk-cover" style={{ height: box.h }}>
          {cover ? (
            <BlobImage
              store={store}
              fileRef={imageFileRef(cover)}
              alt=""
              className="dk-art"
              thumbnail
              thumbnailSize={pinned ? COVER_THUMBNAIL_SIZE : undefined}
              lazy
              blur={coverBlurred}
            />
          ) : (
            <span className="dk-cover-empty"><ImagesSquare size={30} weight="duotone" /></span>
          )}
          <span className="dk-ck" data-check role="checkbox" aria-checked={selected} aria-label={`选择图包${folder.name}`}>
            <Check size={12} weight="bold" />
          </span>
          {pinned && <span className="dk-badge tr"><PushPin size={11} weight="fill" />固定封面</span>}
          <span className="dk-more" data-more title="更多操作" aria-label={`${folder.name}的更多操作`}>
            <DotsThree size={18} weight="bold" />
          </span>
          <span className="dk-badge br num"><ImageSquare size={12} />{formatCount(folder.imageCount)}</span>
        </div>
      </div>
      <div className="dk-name">
        {folder.name}
        {data.fresh && <span className="dk-new" title="新导入" />}
      </div>
      <div className="dk-sub">{sub}</div>
    </div>
  );
});

export const PackListRow = memo(function PackListRow({
  data,
  box,
  store,
  selected,
  focused,
  coverBlurred,
}: {
  data: PackCardData;
  box: ItemBox;
  store: LibraryStore;
  selected: boolean;
  focused: boolean;
  coverBlurred: boolean;
}) {
  const { folder, cover, pinned } = data;
  return (
    <div
      className={`dk-lrow dk-pack-row ${selected ? 'sel' : ''} ${focused ? 'focus' : ''}`}
      style={boxStyle(box, box.h)}
      data-item={`f:${folder.id}`}
      role="row"
      aria-selected={selected}
    >
      <span className="dk-cbx" data-check role="checkbox" aria-checked={selected} aria-label={`选择图包${folder.name}`}>
        <Check size={11} weight="bold" />
      </span>
      <span className="dk-lth">
        {cover && <BlobImage store={store} fileRef={imageFileRef(cover)} alt="" className="dk-art" thumbnail lazy blur={coverBlurred} />}
      </span>
      <span className="dk-lname" title={folder.name}>
        {folder.name}
        {pinned && <PushPin size={12} weight="fill" className="dk-lpin" />}
        {data.fresh && <span className="dk-new" title="新导入" />}
      </span>
      <span className="num">{formatCount(folder.imageCount)}</span>
      <span className="num">{folder.childCount || '—'}</span>
      <span className="num">{formatBytes(data.bytes)}</span>
      <span>{data.importedLabel ?? '—'}</span>
      <span className="dk-more" data-more title="更多操作" aria-label={`${folder.name}的更多操作`}>
        <DotsThree size={18} weight="bold" />
      </span>
    </div>
  );
});
