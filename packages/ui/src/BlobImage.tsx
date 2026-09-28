import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import { DEFAULT_THUMBNAIL_SIZE, getThumbnailBlob, peekThumbnailBlob } from './thumbnailCache';
import { observeVisibility } from './visibleObserver';
import { acquireObjectUrl, releaseObjectUrl } from './objectUrlPool';
import { BLUR_PREVIEW_CSS_FRACTION, getBlurPreviewBlob, peekBlurPreviewBlob } from './blurPreview';
import { logDebug } from './debugLog';

type LoadedImage = { key: string; url: string; degraded: boolean };

/**
 * 缓存键契约（纯函数，供回归测试钉住）：
 * - 键由「文件身份（id/mtime/size）+ 资源档位」组成：重命名 / 移动 / 内容替换
 *   都会换键——缓存只会 miss 而不会误命中旧条目；
 * - 缩略图与全图、不同缩略图尺寸的键互不相同；
 * - 糊化预览的身份不含尺寸段：不同尺寸入口共享同一份糊化结果（见 blurPreview.ts）。
 */
export function blobImageResourceKey(
  fileRef: Pick<FileRef, 'id' | 'mtime' | 'size'>,
  thumbnail: boolean,
  thumbnailSize: number,
): string {
  return `${fileRef.id}\u0000${fileRef.mtime ?? ''}\u0000${fileRef.size ?? ''}\u0000${thumbnail ? `thumb-${thumbnailSize}` : 'full'}`;
}

export function blurPreviewIdentity(fileRef: Pick<FileRef, 'id' | 'mtime' | 'size'>): string {
  return `${fileRef.id}\u0000${fileRef.mtime ?? ''}\u0000${fileRef.size ?? ''}`;
}

/** BlobImage 的三态机：骨架（未就绪）/ 图（URL 交付）/ 失败占位。 */
export type BlobImagePhase = 'skeleton' | 'image' | 'failed';

export function blobImagePhase(
  loaded: { key: string; url: string; degraded: boolean } | null,
  failedKey: string | null,
  resourceKey: string,
): BlobImagePhase {
  // 成功交付会清除同资源的失败态（见 commit），二者同时命中时按「已交付」算。
  if (loaded?.key === resourceKey) return 'image';
  if (failedKey === resourceKey) return 'failed';
  return 'skeleton';
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
  // 模糊卡片与普通卡片共用同一缩略图缓存键（thumb-${thumbnailSize}）：源就
  // 是普通尺寸缩略图，不再有专用小图档。切隐私不换键：effect 因 blur 重跑时
  // 缩略图缓存命中走同步重交付，无骨架、无入场动画重播；糊化在 blurPreview.ts
  // 生成路径完成（缩到 128px 小画布做真高斯），展示端无 filter 光栅化。
  const peekCachedThumb = (): Blob | null =>
    thumbnail ? peekThumbnailBlob(fileRef, thumbnailSize) : null;
  const resourceKey = blobImageResourceKey(fileRef, thumbnail, thumbnailSize);
  // 模糊预览的缓存身份（不含尺寸段）：不同尺寸入口拿到的缩略图 Blob 对象
  // 不同，糊化结果视为同一份，按文件身份命中（见 blurPreview.ts）。
  const blurIdentity = blurPreviewIdentity(fileRef);
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<string | null>(null);
  // CSS 兜底半径（px）：冷路径交源图时按显示边长比例取值，与烘焙预览同观感；
  // 交付烘焙图 / 取消隐私时清空。量不出尺寸（display:none 等）时为 null，
  // 退回 .blur-preview 的固定半径类。
  const [cssBlurPx, setCssBlurPx] = useState<number | null>(null);
  // 一律等 IntersectionObserver 触发再加载（缓存命中也不跳过）：全量挂载下
  // 进图包即有数百张卡片，若缓存命中就同步取 URL/解码，几百个 object URL 与
  // 解码请求的洪峰会把进目录卡成秒级。IO 的 rootMargin 300px 足以让可见卡片
  // 一两帧内开始加载；回看不再重载由组件常驻保证（visible 只置真、不回退）。
  const [visible, setVisible] = useState(() => !lazy);
  const containerRef = useRef<HTMLDivElement>(null);
  const phase = blobImagePhase(loaded, failedKey, resourceKey);
  const url = phase === 'image' ? loaded?.url ?? null : null;
  const failed = phase === 'failed';
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
    const commit = (blob: Blob, degraded: boolean, cssPx: number | null = null) => {
      if (cancelled) return;
      const next = acquireObjectUrl(blob);
      // 糊化冷路径会先交源图、生成完再换预览，两次 commit 各自 acquire：
      // 换了 Blob 必须释放上一个 URL，否则它的引用计数永远 >0，池子无法淘汰。
      if (ownedUrl && ownedUrl !== next) releaseObjectUrl(ownedUrl);
      ownedUrl = next;
      // 成功交付即清除本资源的失败态（缓存命中路径不经过下面的清空分支）。
      setFailedKey((current) => (current === resourceKey ? null : current));
      setCssBlurPx(cssPx);
      setLoaded({ key: resourceKey, url: next, degraded });
    };
    // 模糊隐私：源 Blob 先经 blurPreview.ts 糊化（缩到小画布做真高斯），出图
    // 即已糊、无 CSS filter 光栅化。内存层同步命中时零等待；未命中则查
    // IndexedDB 持久层（冷启动不重新生成）；生成期间与生成失败时先交源图、
    // 由按显示尺寸比例的 CSS 高斯兜底（与成品同观感），隐私不降级。
    // blur 必须在依赖里：切换隐私要重新交付。开启时内存命中同步换糊化图；
    // 未命中（首次开启全体冷生成）先同步交源图 + 同强度 CSS 兜底再异步热替
    // 换——此前固定 18px 兜底比成品重 2~3 倍，且移动端全量挂载下几百张排队
    // 生成要数秒，观感即「缩略图消失然后重新出现模糊版」；取消时同步换回
    // 源缩略图。此前 blur 不在依赖里，取消后 src 仍是糊化 Blob，只能靠滚动
    // 重挂载恢复清晰。
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
      // CSS 兜底半径按显示边长 × 4%（与烘焙预览的等效 σ 一致，见
      // blurPreview.ts 的 BLUR_PREVIEW_CSS_FRACTION），小格子不再比成品重。
      const el = containerRef.current;
      const cssPx =
        el && el.clientWidth > 0 ? Math.max(2, Math.round(el.clientWidth * BLUR_PREVIEW_CSS_FRACTION)) : null;
      commit(source, false, cssPx);
      // 真糊化生成只排当前视口内（±320px，与 IO rootMargin 同量级）的卡片：
      // 移动端全量挂载下否则几百张全部入队（4 并发、每张十几毫秒主线程），
      // 视口外的保持 CSS 兜底——观感已与成品一致，桌面端滚回窗口重挂载、
      // 下次切隐私都会自然补上烘焙版。
      const box = el?.getBoundingClientRect();
      const inView =
        !!box && box.top < window.innerHeight + 320 && box.bottom > -320 && box.left < window.innerWidth + 320 && box.right > -320;
      if (!inView) return;
      getBlurPreviewBlob(source, blurIdentity).then((out) => {
        if (!cancelled && out !== source) commit(out, true);
      });
    };
    const cached = peekCachedThumb();
    if (cached) {
      // 缓存命中走同步重交付：同一资源复用池里同一个 URL，切隐私不产生骨
      // 架闪烁，入场动画也不重播。
      deliver(cached);
    } else {
      // 未命中才清空当前展示：异步加载期间不能把上一次 effect 已释放的旧
      // URL 继续挂在 img 上（池子可能已把它撤销），回落骨架。
      setLoaded((current) => (current?.key === resourceKey ? null : current));
      setFailedKey((current) => (current === resourceKey ? null : current));
      const load = thumbnail
        ? getThumbnailBlob(store, fileRef, thumbnailSize, { shouldCancel: () => cancelled })
        : Promise.resolve(store.readBlob(fileRef));
      load
        .then((blob) => {
          if (cancelled) return;
          deliver(blob);
        })
        .catch((err: unknown) => {
          // 落一条诊断日志：用户只看到「读取失败」占位符时，设置→调试面板
          // 能区分文件损坏/权限/格式不支持（不再完全静默）。
          logDebug('image', `图片读取失败 ${fileRef.name}: ${String(err)}`, 'warn');
          if (!cancelled) setFailedKey(resourceKey);
        });
    }
    return () => {
      cancelled = true;
      if (ownedUrl) releaseObjectUrl(ownedUrl);
    };
  }, [store, fileRef.id, fileRef.mtime, fileRef.size, resourceKey, blurIdentity, shouldLoad, thumbnail, thumbnailSize, blur]);

  // 缩略图优先显示图像靠上的部分（object-cover 裁剪默认居中，会裁掉主体所在的
  // 上半部）；原图查看不受影响。
  const coverClass = thumbnail ? ' object-top' : '';
  // 糊化预览已自带高斯（degraded），去掉 CSS blur 及配套的 scale 补边；生成
  // 期间 / 生成失败回落源 Blob 时按显示尺寸比例做 CSS 高斯（与成品同观感），
  // 量不出尺寸才退回 .blur-preview 的固定半径类。
  // 入场不做渐入（opacity 从 0 起的淡入洪峰正是“快速滑动整屏空白”的来源），
  // 骨架一直保留到 img 解码完成（onLoad）才交接——URL 就绪 ≠ 已画得出，
  // 解码空窗期图片“可见但没画出来”，极高速滑动下就是空白卡片。
  const cssFallback = blur && url != null && loaded?.degraded === false;
  const imageClass = `${className ?? ''}${cssFallback && cssBlurPx == null ? ' blur-preview' : ''}${coverClass}`;
  const fallbackStyle =
    cssFallback && cssBlurPx != null ? { filter: `blur(${cssBlurPx}px)`, transform: 'scale(1.06)' } : undefined;
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
        style={fallbackStyle}
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
