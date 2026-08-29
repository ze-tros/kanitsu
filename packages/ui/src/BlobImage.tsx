import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import { getThumbnailBlob, peekThumbnailBlob } from './thumbnailCache';
import { observeVisibility } from './visibleObserver';
import { acquireObjectUrl, releaseObjectUrl } from './objectUrlPool';

export function BlobImage({
  store,
  fileRef,
  alt,
  className,
  thumbnail = false,
  lazy = false,
  blur = false,
}: {
  store: LibraryStore;
  fileRef: FileRef;
  alt?: string;
  className?: string;
  thumbnail?: boolean;
  lazy?: boolean;
  blur?: boolean;
}) {
  const resourceKey = `${fileRef.id}\u0000${fileRef.mtime ?? ''}\u0000${fileRef.size ?? ''}\u0000${thumbnail ? 'thumb' : 'full'}`;
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [visible, setVisible] = useState(!lazy);
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
    const cached = thumbnail ? peekThumbnailBlob(fileRef, 512) : null;
    if (cached) {
      const next = acquireObjectUrl(cached);
      ownedUrl = next;
      setLoaded({ key: resourceKey, url: next });
      return () => releaseObjectUrl(next);
    }
    const load = thumbnail ? getThumbnailBlob(store, fileRef, 512) : Promise.resolve(store.readBlob(fileRef));
    load
      .then((blob) => {
        if (cancelled) return;
        const next = acquireObjectUrl(blob);
        ownedUrl = next;
        setLoaded({ key: resourceKey, url: next });
      })
      .catch(() => {
        if (!cancelled) setFailedKey(resourceKey);
      });
    return () => {
      cancelled = true;
      if (ownedUrl) releaseObjectUrl(ownedUrl);
    };
  }, [store, fileRef.id, fileRef.mtime, fileRef.size, resourceKey, shouldLoad, thumbnail]);

  // 缩略图优先显示图像靠上的部分（object-cover 裁剪默认居中，会裁掉主体所在的
  // 上半部）；原图查看不受影响。
  const coverClass = thumbnail ? ' object-top' : '';
  const imageClass = `${className ?? ''}${blur ? ' blur-preview' : ''}${coverClass}${url ? ' kanitsu-image-in' : ''}`;
  return (
    <div
      className={`blob-image w-full h-full${url ? ' is-ready' : ''}${failed ? ' failed' : ''}`}
      ref={containerRef}
      aria-label={!url && !failed ? '加载中' : undefined}
    >
      <img src={url ?? undefined} alt={alt ?? fileRef.name} className={imageClass} loading="lazy" />
      <div className="blob-image-shimmer" aria-hidden="true" />
      <div className="blob-image-spinner" aria-hidden="true" />
      <span className="blob-image-error text-sm opacity-60">图片读取失败</span>
    </div>
  );
}
