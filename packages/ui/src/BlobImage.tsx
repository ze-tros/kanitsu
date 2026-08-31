import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import { DEFAULT_THUMBNAIL_SIZE, getThumbnailBlob, peekThumbnailBlob } from './thumbnailCache';
import { observeVisibility } from './visibleObserver';
import { acquireObjectUrl, releaseObjectUrl } from './objectUrlPool';

type LoadedImage = { key: string; url: string; animate: boolean };

// 虚拟列表会反复挂载同一张图片。记录已经出场过的资源，避免每次滚动回到
// 同一行时重新触发淡入动画；key 包含 mtime/size，文件更新后会重新播放一次。
const animatedImageKeys = new Set<string>();

function takeAnimation(key: string): boolean {
  if (animatedImageKeys.has(key)) return false;
  animatedImageKeys.add(key);
  return true;
}

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
  const resourceKey = `${fileRef.id}\u0000${fileRef.mtime ?? ''}\u0000${fileRef.size ?? ''}\u0000${thumbnail ? `thumb-${thumbnailSize}` : 'full'}`;
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [visible, setVisible] = useState(() => {
    if (!lazy) return true;
    // 懒加载只应延迟冷缓存请求；已经生成好的缩略图可以直接进入加载流程，
    // 避免虚拟列表滚回时还要等待 IntersectionObserver 再闪一遍占位。
    return thumbnail && peekThumbnailBlob(fileRef, thumbnailSize) !== null;
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
    const cached = thumbnail ? peekThumbnailBlob(fileRef, thumbnailSize) : null;
    if (cached) {
      const next = acquireObjectUrl(cached);
      ownedUrl = next;
      setLoaded({ key: resourceKey, url: next, animate: takeAnimation(resourceKey) });
      return () => releaseObjectUrl(next);
    }
    const load = thumbnail ? getThumbnailBlob(store, fileRef, thumbnailSize) : Promise.resolve(store.readBlob(fileRef));
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
  }, [store, fileRef.id, fileRef.mtime, fileRef.size, resourceKey, shouldLoad, thumbnail, thumbnailSize]);

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
