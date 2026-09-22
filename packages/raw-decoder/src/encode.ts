/**
 * 浏览器/WebView 环境的像素编码工具:RGB(A) 像素 → JPEG Blob。
 * 依赖 OffscreenCanvas(Electron 渲染进程与 Android WebView 均支持)。
 */

/** RGB(3 字节/像素)→ RGBA(4 字节/像素),供 ImageData 使用。 */
export function rgbToRgba(rgb: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const pixels = width * height;
  const rgba = new Uint8ClampedArray(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    rgba[p * 4] = rgb[p * 3]!;
    rgba[p * 4 + 1] = rgb[p * 3 + 1]!;
    rgba[p * 4 + 2] = rgb[p * 3 + 2]!;
    rgba[p * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * RGB8 像素编码为 JPEG Blob;最长边超过 maxDim 时等比缩小。
 * 缩小经 drawImage 完成(浏览器自带的良好的重采样质量)。
 */
export async function encodeRgbJpeg(
  rgb: Uint8Array,
  width: number,
  height: number,
  opts?: { maxDim?: number; quality?: number },
): Promise<Blob> {
  const maxDim = opts?.maxDim ?? 0;
  const quality = opts?.quality ?? 0.9;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d 上下文不可用');
  const imgData = ctx.createImageData(width, height);
  imgData.data.set(rgbToRgba(rgb, width, height));
  ctx.putImageData(imgData, 0, 0);
  if (maxDim > 0 && Math.max(width, height) > maxDim) {
    const scale = maxDim / Math.max(width, height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const scaled = new OffscreenCanvas(w, h);
    const sctx = scaled.getContext('2d');
    if (!sctx) throw new Error('OffscreenCanvas 2d 上下文不可用');
    sctx.drawImage(canvas, 0, 0, w, h);
    return await scaled.convertToBlob({ type: 'image/jpeg', quality });
  }
  return await canvas.convertToBlob({ type: 'image/jpeg', quality });
}
