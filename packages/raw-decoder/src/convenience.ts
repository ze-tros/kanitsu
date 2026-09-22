/**
 * RAW 便捷入口:一次性解码(内部开/关会话)。
 * 渐进式加载(预览 → 完整解码)请用 openBrowserRawSession 复用同一次 open。
 */
import { openBrowserRawSession } from './browser/client';
import { encodeRgbJpeg } from './encode';
import { resolveRawDecodeOptions, type RawDecodeOptions } from './options';

/**
 * 提取相机内嵌预览并编码为 JPEG Blob(预览本身是 JPEG 时字节直通,零重编码)。
 * 无内嵌预览时返回 null,调用方应回退到 decodeRawToJpeg(halfSize)。
 */
export async function extractRawPreviewJpeg(
  bytes: Uint8Array,
  opts?: RawDecodeOptions & { quality?: number },
): Promise<Blob | null> {
  const session = await openBrowserRawSession(bytes, opts);
  try {
    const thumb = await session.thumbnail();
    if (!thumb) return null;
    if (thumb.kind === 'jpeg') {
      return new Blob([thumb.data as BlobPart], { type: 'image/jpeg' });
    }
    return await encodeRgbJpeg(thumb.data, thumb.width, thumb.height, { quality: opts?.quality ?? 0.9 });
  } finally {
    session.close();
  }
}

/**
 * 完整解码 → JPEG Blob。maxDim 限制最长边(超限等比缩小),
 * Android 端建议 4096 以控内存;配合 halfSize 可再快 4 倍。
 */
export async function decodeRawToJpeg(
  bytes: Uint8Array,
  opts?: RawDecodeOptions & { maxDim?: number; quality?: number },
): Promise<Blob> {
  const resolved = resolveRawDecodeOptions(opts);
  const session = await openBrowserRawSession(bytes, resolved);
  try {
    const pixels = await session.pixels();
    return await encodeRgbJpeg(pixels.data, pixels.width, pixels.height, {
      maxDim: opts?.maxDim ?? 0,
      quality: opts?.quality ?? 0.9,
    });
  } finally {
    session.close();
  }
}

/** 内嵌 JPEG 预览超过网格缩略图需求时降采样,控制 Blob 体积(内存 LRU 按字节计)。 */
async function downscaleJpegBlob(blob: Blob, maxDim: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return blob;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } finally {
    bitmap.close();
  }
}

/**
 * RAW 网格缩略图:内嵌预览(降采样到 targetDim)优先;无预览时回退
 * halfSize 完整解码。混合策略的快路径。
 */
export async function decodeRawThumbnailJpeg(
  bytes: Uint8Array,
  opts?: { targetDim?: number; quality?: number },
): Promise<Blob> {
  const targetDim = opts?.targetDim ?? 512;
  const quality = opts?.quality ?? 0.85;
  const preview = await extractRawPreviewJpeg(bytes, { quality });
  if (preview) {
    return await downscaleJpegBlob(preview, Math.round(targetDim * 1.5), quality);
  }
  return await decodeRawToJpeg(bytes, { halfSize: true, maxDim: targetDim, quality });
}
