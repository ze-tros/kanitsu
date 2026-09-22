/**
 * 隐私模糊预览：降采样重采样模糊（downscale–upscale，"缩放模糊"）。
 *
 * 旧方案是 CSS `filter: blur()` 高斯模糊：每张卡都要在显示分辨率下做一次
 * 卷积光栅化，隐私模式整屏滚动时是稳定的掉帧来源。这里换成重采样模糊：
 * 源图先缩到 BLUR_PREVIEW_IN_PX 级别、再平滑放大——细节等效于 24px 级别的
 * 重糊，而成本只是两次 canvas 贴图缩放。结果按源 Blob 记忆（WeakMap），同一
 * 缩略图只处理一次，虚拟列表反复挂载时同步命中；展示端是普通 <img>，无
 * filter 光栅化，快速滚动零持续开销。
 *
 * 失败（canvas / createImageBitmap 不可用等）时原样返回源 Blob，由调用方
 * 保留 CSS blur 兜底，隐私不降级。
 */
const BLUR_PREVIEW_IN_PX = 24;
const BLUR_PREVIEW_OUT_PX = 128;
const BLUR_PREVIEW_TYPE = 'image/jpeg';
const BLUR_PREVIEW_QUALITY = 0.85;

/** 源 Blob → 降采样结果；生成失败时映射为源 Blob 本身（作为不再重试的标记）。 */
const previews = new WeakMap<Blob, Blob>();
/** 源 Blob → 进行中的生成，供并发挂载去重。 */
const pending = new WeakMap<Blob, Promise<Blob>>();

/** 同步窥探已生成的降采样预览；返回源 Blob 本身表示此前生成失败（走 CSS blur 兜底）。 */
export function peekBlurPreviewBlob(source: Blob): Blob | null {
  return previews.get(source) ?? null;
}

/** 取源 Blob 的降采样预览；失败时 resolve 源 Blob 本身。 */
export function getBlurPreviewBlob(source: Blob): Promise<Blob> {
  const settled = previews.get(source);
  if (settled) return Promise.resolve(settled);
  const inFlight = pending.get(source);
  if (inFlight) return inFlight;
  const task = acquireRenderSlot()
    .then(() => renderBlurPreview(source))
    .finally(() => releaseRenderSlot())
    .catch((err: unknown) => {
      // 回落是静默生效的（调用方拿源 Blob + CSS blur），但必须留痕：
      // 没有这条告警就无法区分“降采样路径生效”和“一直在付 CSS blur 成本”。
      console.warn('[blurPreview] degrade failed, falling back to CSS blur', err);
      return source;
    })
    .then((out) => {
      previews.set(source, out);
      pending.delete(source);
      return out;
    });
  pending.set(source, task);
  return task;
}

/**
 * 降采样生成并发上限：极快滑动会瞬间排入几十张，若任由并行，一波
 * createImageBitmap / canvas / toBlob 会饿死渲染提交，冻结的挂载窗口
 * 跟不上视口（整屏空白的放大器）。限流后渲染帧始终有插队机会。
 */
const MAX_PARALLEL_RENDERS = 2;
let activeRenders = 0;
const renderWaiters: Array<() => void> = [];

function acquireRenderSlot(): Promise<void> {
  return new Promise((resolve) => {
    const take = (): void => {
      activeRenders++;
      resolve();
    };
    if (activeRenders < MAX_PARALLEL_RENDERS) take();
    else renderWaiters.push(take);
  });
}

function releaseRenderSlot(): void {
  activeRenders--;
  const next = renderWaiters.shift();
  if (next) next();
}

/** 两阶段重采样：先缩到 IN 级别丢掉细节，再平滑放大到 OUT 级别抹掉缩放颗粒。 */
async function renderBlurPreview(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const { width: w, height: h } = bitmap;
    const inScale = Math.min(1, BLUR_PREVIEW_IN_PX / Math.max(w, h, 1));
    const sw = Math.max(1, Math.round(w * inScale));
    const sh = Math.max(1, Math.round(h * inScale));
    const down = document.createElement('canvas');
    down.width = sw;
    down.height = sh;
    const dctx = down.getContext('2d');
    if (!dctx) throw new Error('canvas 2d unavailable');
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(bitmap, 0, 0, sw, sh);

    const k = BLUR_PREVIEW_OUT_PX / BLUR_PREVIEW_IN_PX;
    const up = document.createElement('canvas');
    up.width = Math.max(1, Math.round(sw * k));
    up.height = Math.max(1, Math.round(sh * k));
    const uctx = up.getContext('2d');
    if (!uctx) throw new Error('canvas 2d unavailable');
    uctx.imageSmoothingQuality = 'high';
    uctx.drawImage(down, 0, 0, up.width, up.height);

    return await new Promise<Blob>((resolve, reject) => {
      up.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
        BLUR_PREVIEW_TYPE,
        BLUR_PREVIEW_QUALITY,
      );
    });
  } finally {
    bitmap.close();
  }
}
