import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import { DEFAULT_THUMBNAIL_SIZE, getThumbnailBlob, peekThumbnailBlob } from './thumbnailCache';
import { observeVisibility } from './visibleObserver';
import { acquireObjectUrl, releaseObjectUrl } from './objectUrlPool';
import { getBlurPreviewBlob, peekBlurPreviewBlob } from './blurPreview';

type LoadedImage = { key: string; url: string; degraded: boolean };

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
  // 模糊卡片与普通卡片共用同一缩略图缓存键（thumb-${thumbnailSize}）：源就
  // 是普通尺寸缩略图，不再有专用小图档。切隐私不换键，此前“切换后整屏重新
  // 加载 / 入场动画重播”的问题从根上不存在；糊化在 blurPreview.ts 生成路径
  // 完成（缩到 128px 小画布做真高斯），展示端无 filter 光栅化。
  const peekCachedThumb = (): Blob | null =>
    thumbnail ? peekThumbnailBlob(fileRef, thumbnailSize) : null;
  const resourceKey = `${fileRef.id}\u0000${fileRef.mtime ?? ''}\u0000${fileRef.size ?? ''}\u0000${thumbnail ? `thumb-${thumbnailSize}` : 'full'}`;
  // 模糊预览的缓存身份（不含尺寸段）：不同尺寸入口拿到的缩略图 Blob 对象
  // 不同，糊化结果视为同一份，按文件身份命中（见 blurPreview.ts）。
  const blurIdentity = `${fileRef.id}\u0000${fileRef.mtime ?? ''}\u0000${fileRef.size ?? ''}`;
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
    // 模糊隐私：源 Blob 先经 blurPreview.ts 糊化（缩到小画布做真高斯），出图
    // 即已糊、无 CSS filter 光栅化。内存层同步命中时零等待；未命中则查
    // IndexedDB 持久层（冷启动不重新生成）；失败时回落源 Blob 并由
    // .blur-preview 的 CSS blur 兜底，隐私不降级。
    const deliver = (source: Blob) => {
      if (!blur || !thumbnail) {
        commit(source, false);
        return;
      }
      const preview = peekBlurPreviewBlob(blurIdentity);
      if (preview) {
        commit(preview, preview !== source);
        return;
      }
      getBlurPreviewBlob(source, blurIdentity).then((out) => commit(out, out !== source));
    };
    const cached = peekCachedThumb();
    if (cached) {
      deliver(cached);
    } else {
      const load = thumbnail
        ? getThumbnailBlob(store, fileRef, thumbnailSize, { shouldCancel: () => cancelled })
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
  }, [store, fileRef.id, fileRef.mtime, fileRef.size, resourceKey, shouldLoad, thumbnail, thumbnailSize]);

  // 缩略图优先显示图像靠上的部分（object-cover 裁剪默认居中，会裁掉主体所在的
  // 上半部）；原图查看不受影响。
  const coverClass = thumbnail ? ' object-top' : '';
  // 糊化预览已自带高斯（degraded），去掉 CSS blur 及配套的 scale 补边；
  // 仅生成失败回落源 Blob 时保留 .blur-preview 的高斯模糊兜底。
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
