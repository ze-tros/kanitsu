import { useEffect, useRef, useState } from 'react';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import { getThumbnailBlob } from './thumbnailCache';

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
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(!lazy);
  const containerRef = useRef<HTMLDivElement>(null);

  // Lazily start loading only when the element scrolls near the viewport.
  useEffect(() => {
    if (!lazy || visible) return;
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [lazy, visible]);

  useEffect(() => {
    if (!visible) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    // 缩略图走内存缓存：同一文件切走再切回时直接复用已生成的 Blob，
    // 不再触发 IPC / 磁盘解码 / 重新编码（见 thumbnailCache.ts）。
    const load = thumbnail ? getThumbnailBlob(store, fileRef, 512) : Promise.resolve(store.readBlob(fileRef));
    load
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [store, fileRef.id, fileRef.mtime, fileRef.size, visible, thumbnail]);

  if (failed) {
    return (
      <div className={`blob-image failed w-full h-full flex items-center justify-center ${className ?? ''}`} ref={containerRef}>
        <span className="text-sm opacity-60">图片读取失败</span>
      </div>
    );
  }
  if (!url) {
    return (
      <div className={`blob-image w-full h-full ${className ?? ''}`} ref={containerRef} aria-label="加载中">
        <div className="blob-image-shimmer" />
        <div className="blob-image-spinner" aria-hidden="true" />
      </div>
    );
  }
  // 缩略图优先显示图像靠上的部分（object-cover 裁剪默认居中，会裁掉主体所在的
  // 上半部）；原图查看不受影响。
  const coverClass = thumbnail ? ' object-top' : '';
  return <img src={url} alt={alt ?? fileRef.name} className={`${className ?? ''}${blur ? ' blur-preview' : ''}${coverClass}`} loading="lazy" />;
}
