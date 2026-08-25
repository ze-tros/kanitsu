import { useEffect, useRef, useState } from 'react';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import { getThumbnailBlob, peekThumbnailBlob } from './thumbnailCache';

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
  // 挂载时若缓存已命中则同步生成 object URL：切换文件夹时命中缓存的图
  // 直接出图，不闪加载条（未命中则走下方 effect 异步加载）。
  const [url, setUrl] = useState<string | null>(() => {
    if (!thumbnail) return null;
    const cached = peekThumbnailBlob(fileRef, 512);
    return cached ? URL.createObjectURL(cached) : null;
  });
  const urlRef = useRef<string | null>(url);
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
    let cancelled = false;
    setFailed(false);
    // 缩略图走内存缓存：同一文件切走再切回时直接复用已生成的 Blob，
    // 不再触发 IPC / 磁盘解码 / 重新编码（见 thumbnailCache.ts）。
    const load = thumbnail ? getThumbnailBlob(store, fileRef, 512) : Promise.resolve(store.readBlob(fileRef));
    load
      .then((blob) => {
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        // 替换旧 URL（含挂载时预热生成的），保持 urlRef 始终指向当前展示的 URL。
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        setUrl(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
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
