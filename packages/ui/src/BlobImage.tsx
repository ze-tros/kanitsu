import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import { DEFAULT_THUMBNAIL_SIZE, getThumbnailBlob, peekThumbnailBlob } from './thumbnailCache';
import { observeVisibility } from './visibleObserver';
import { acquireObjectUrl, releaseObjectUrl } from './objectUrlPool';
import { getBlurPreviewBlob, peekBlurPreviewBlob } from './blurPreview';

type LoadedImage = { key: string; url: string; degraded: boolean };

/** 隐私模糊预览专用极小缩略图：展示前经 blurPreview.ts 降采样重采样糊化，
    小尺寸让生成、解码与内存开销都比全尺寸缩略图低一个量级。 */
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
  // 极小图与普通尺寸是两个缓存键：启用隐私预览后若只按 48px 键查缓存，之前
  // 按普通尺寸加载/预取过的图片会全部未命中、整屏重新生成（“隐私模式下大量
  // 重新加载”）。模糊展示对分辨率不敏感，未命中极小图时回退复用普通尺寸的
  // 缓存条目即可直接出图；冷条目仍生成 48px 保留解码/内存优化。
  const fallbackThumbSize = thumbSize !== thumbnailSize ? thumbnailSize : null;
  const peekCachedThumb = (): Blob | null =>
    thumbnail
      ? peekThumbnailBlob(fileRef, thumbSize) ??
        (fallbackThumbSize !== null ? peekThumbnailBlob(fileRef, fallbackThumbSize) : null)
      : null;
  const resourceKey = `${fileRef.id}\u0000${fileRef.mtime ?? ''}\u0000${fileRef.size ?? ''}\u0000${thumbnail ? `thumb-${thumbSize}` : 'full'}`;
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<string | null>(null);
  // 一律等 IntersectionObserver 触发再加载（缓存命中也不跳过）：全量挂载下
  // 进图包即有数百张卡片，若缓存命中就同步取 URL/解码，几百个 object URL 与
  // 解码请求的洪峰会把进目录卡成秒级。IO 的 rootMargin 300px 足以让可见卡片
  // 一两帧内开始加载；回看不再重载由组件常驻保证（visible 只置真、不回退）。
  const [visible, setVisible] = useState(() => !lazy);
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
    const commit = (blob: Blob, degraded: boolean) => {
      if (cancelled) return;
      const next = acquireObjectUrl(blob);
      ownedUrl = next;
      setLoaded({ key: resourceKey, url: next, degraded });
    };
    // 模糊隐私：源 Blob 先经降采样重采样模糊（见 blurPreview.ts），出图即已
    // 糊、无 CSS filter 光栅化。降采样结果同步命中时零等待；失败时回落源
    // Blob 并由 .blur-preview 的 CSS blur 兜底，隐私不降级。
    const deliver = (source: Blob) => {
      if (!blur || !thumbnail) {
        commit(source, false);
        return;
      }
      const preview = peekBlurPreviewBlob(source);
      if (preview) {
        commit(preview, preview !== source);
        return;
      }
      getBlurPreviewBlob(source).then((out) => commit(out, out !== source));
    };
    const cached = peekCachedThumb();
    if (cached) {
      deliver(cached);
    } else {
      const load = thumbnail
        ? getThumbnailBlob(store, fileRef, thumbSize, { shouldCancel: () => cancelled })
        : Promise.resolve(store.readBlob(fileRef));
      load
        .then((blob) => {
          if (cancelled) return;
          deliver(blob);
        })
        .catch(() => {
          if (!cancelled) setFailedKey(resourceKey);
        });
    }
    return () => {
      cancelled = true;
      if (ownedUrl) releaseObjectUrl(ownedUrl);
    };
  }, [store, fileRef.id, fileRef.mtime, fileRef.size, resourceKey, shouldLoad, thumbnail, thumbSize, fallbackThumbSize]);

  // 缩略图优先显示图像靠上的部分（object-cover 裁剪默认居中，会裁掉主体所在的
  // 上半部）；原图查看不受影响。
  const coverClass = thumbnail ? ' object-top' : '';
  // 降采样预览已自带糊化（degraded），去掉 CSS blur 及配套的 scale 补边；
  // 仅降采样失败回落源 Blob 时保留 .blur-preview 的高斯模糊兜底。
  // 入场不做渐入（opacity 从 0 起的淡入洪峰正是“快速滑动整屏空白”的来源），
  // 骨架一直保留到 img 解码完成（onLoad）才交接——URL 就绪 ≠ 已画得出，
  // 解码空窗期图片“可见但没画出来”，极高速滑动下就是空白卡片。
  const imageClass = `${className ?? ''}${blur && !loaded?.degraded ? ' blur-preview' : ''}${coverClass}`;
  const shown = url != null && shownKey === resourceKey;
  return (
    <div
      className={`blob-image w-full h-full${shown ? ' is-ready' : ''}${failed ? ' failed' : ''}`}
      ref={containerRef}
      aria-label={!shown && !failed ? '加载中' : undefined}
    >
      <img
        src={url ?? undefined}
        alt={alt ?? fileRef.name}
        className={imageClass}
        loading="eager"
        onLoad={() => setShownKey(resourceKey)}
        onError={() => setFailedKey(resourceKey)}
      />
      {/* 骨架底色层（仅移动端经 CSS 启用，见 styles.css .blob-image-skeleton）：
          快速滑动时未加载项渲染为内容形状的骨架块，而不是透明底 + 冻结 spinner。 */}
      <div className="blob-image-skeleton" aria-hidden="true" />
      <div className="blob-image-shimmer" aria-hidden="true" />
      <div className="blob-image-spinner" aria-hidden="true" />
      <span className="blob-image-error text-sm opacity-60">图片读取失败</span>
    </div>
  );
}
