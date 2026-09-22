import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import { DEFAULT_THUMBNAIL_SIZE, getThumbnailBlob, peekThumbnailBlob } from './thumbnailCache';
import { observeVisibility } from './visibleObserver';
import { acquireObjectUrl, releaseObjectUrl } from './objectUrlPool';

type LoadedImage = { key: string; url: string; animate: boolean };

// 虚拟列表会反复挂载同一张图片。记录已经出场过的资源，避免每次滚动回到
// 同一行时重新触发淡入动画；key 包含 mtime/size，文件更新后会重新播放一次。
const animatedImageKeys = new Set<string>();

// 滚动期间跳过入场动画：快速滑动时每帧都有新卡片挂载，同时播放几十个淡入
// 动画本身就是掉帧源（表现为“卡片消失、停下才出现”）。滚停后不补播——
// 补播会让整屏图片同时闪一遍，所以直接把出场标记写掉。
let imageMotionSuppressed = false;

/** 滚动开始时置 true、滚动停止后置 false（移动端列表在 onScroll 里驱动）。 */
export function setImageMotionSuppressed(suppressed: boolean): void {
  imageMotionSuppressed = suppressed;
}

function takeAnimation(key: string): boolean {
  if (imageMotionSuppressed) {
    animatedImageKeys.add(key);
    return false;
  }
  if (animatedImageKeys.has(key)) return false;
  animatedImageKeys.add(key);
  return true;
}

/** 隐私模糊预览专用极小缩略图：小图放大本身就是重模糊，CSS blur 只需少量
    半径抹平放大颗粒。生成、解码与内存开销都比全尺寸缩略图低一个量级。 */
export const BLUR_THUMBNAIL_SIZE = 48;

export function BlobImage({
  store,
  fileRef,
  alt,
  className,
  thumbnail = false,
  lazy = false,
  blur = false,
  thumbnailSize = DEFAULT_THUMBNAIL_SIZE,
}: {
  store: LibraryStore;
  fileRef: FileRef;
  alt?: string;
  className?: string;
  thumbnail?: boolean;
  lazy?: boolean;
  blur?: boolean;
  thumbnailSize?: number;
}) {
  // 模糊预览走极小缩略图（见 BLUR_THUMBNAIL_SIZE）：显示效果由放大 + 少量
  // CSS blur 完成，隐私模式下批量滚动的解码/栅格化成本大幅下降。
  const thumbSize = blur && thumbnail ? Math.min(thumbnailSize, BLUR_THUMBNAIL_SIZE) : thumbnailSize;
  const resourceKey = `${fileRef.id}\u0000${fileRef.mtime ?? ''}\u0000${fileRef.size ?? ''}\u0000${thumbnail ? `thumb-${thumbSize}` : 'full'}`;
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [visible, setVisible] = useState(() => {
    if (!lazy) return true;
    // 懒加载只应延迟冷缓存请求；已经生成好的缩略图可以直接进入加载流程，
    // 避免虚拟列表滚回时还要等待 IntersectionObserver 再闪一遍占位。
    return thumbnail && peekThumbnailBlob(fileRef, thumbSize) !== null;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const url = loaded?.key === resourceKey ? loaded.url : null;
  const failed = failedKey === resourceKey;
  const shouldLoad = !lazy || visible;

  // Lazily start loading only when the element scrolls near the viewport.
  // 所有卡片共享同一个 IntersectionObserver 单例（visibleObserver.ts），
  // 几千张图只注册一个观察器，不再每卡一个 IO。
  useEffect(() => {
    if (!lazy || visible) return;
    const el = containerRef.current;
    if (!el) return;
    return observeVisibility(el, (isIntersecting) => {
      if (isIntersecting) setVisible(true);
    });
  }, [lazy, visible]);

  useLayoutEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    let ownedUrl: string | null = null;
    // A previous effect already released its URL. Clear a matching stale state
    // before an A -> B -> A resource cycle can expose that released URL again.
    setLoaded((current) => (current?.key === resourceKey ? null : current));
    setFailedKey((current) => (current === resourceKey ? null : current));
    // 缩略图走内存缓存：同一文件切走再切回时直接复用已生成的 Blob，
    // 不再触发 IPC / 磁盘解码 / 重新编码（见 thumbnailCache.ts）。
    const cached = thumbnail ? peekThumbnailBlob(fileRef, thumbSize) : null;
    if (cached) {
      const next = acquireObjectUrl(cached);
      ownedUrl = next;
      setLoaded({ key: resourceKey, url: next, animate: takeAnimation(resourceKey) });
      return () => releaseObjectUrl(next);
    }
    const load = thumbnail
      ? getThumbnailBlob(store, fileRef, thumbSize, { shouldCancel: () => cancelled })
      : Promise.resolve(store.readBlob(fileRef));
    load
      .then((blob) => {
        if (cancelled) return;
        const next = acquireObjectUrl(blob);
        ownedUrl = next;
        setLoaded({ key: resourceKey, url: next, animate: takeAnimation(resourceKey) });
      })
      .catch(() => {
        if (!cancelled) setFailedKey(resourceKey);
      });
    return () => {
      cancelled = true;
      if (ownedUrl) releaseObjectUrl(ownedUrl);
    };
  }, [store, fileRef.id, fileRef.mtime, fileRef.size, resourceKey, shouldLoad, thumbnail, thumbSize]);

  // 缩略图优先显示图像靠上的部分（object-cover 裁剪默认居中，会裁掉主体所在的
  // 上半部）；原图查看不受影响。
  const coverClass = thumbnail ? ' object-top' : '';
  const imageClass = `${className ?? ''}${blur ? ' blur-preview' : ''}${coverClass}${loaded?.animate ? ' kanitsu-image-in' : ''}`;
  return (
    <div
      className={`blob-image w-full h-full${url ? ' is-ready' : ''}${failed ? ' failed' : ''}`}
      ref={containerRef}
      aria-label={!url && !failed ? '加载中' : undefined}
    >
      <img src={url ?? undefined} alt={alt ?? fileRef.name} className={imageClass} loading="eager" />
      <div className="blob-image-shimmer" aria-hidden="true" />
      <div className="blob-image-spinner" aria-hidden="true" />
      <span className="blob-image-error text-sm opacity-60">图片读取失败</span>
    </div>
  );
}
