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
 * rotateDeg(顺时针)先于缩放应用——rgb 位图预览没有 EXIF 方向标记,
 * 必须在编码时把方向烘进像素。
 */
export async function encodeRgbJpeg(
  rgb: Uint8Array,
  width: number,
  height: number,
  opts?: { maxDim?: number; quality?: number; rotateDeg?: number },
): Promise<Blob> {
  const maxDim = opts?.maxDim ?? 0;
  const quality = opts?.quality ?? 0.9;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d 上下文不可用');
  const imgData = ctx.createImageData(width, height);
  imgData.data.set(rgbToRgba(rgb, width, height));
  ctx.putImageData(imgData, 0, 0);

  const deg = opts?.rotateDeg ?? 0;
  let out: OffscreenCanvas = canvas;
  if (deg === 90 || deg === 180 || deg === 270) {
    const swapped = deg !== 180;
    const rotated = new OffscreenCanvas(swapped ? height : width, swapped ? width : height);
    const rctx = rotated.getContext('2d');
    if (!rctx) throw new Error('OffscreenCanvas 2d 上下文不可用');
    rctx.translate(rotated.width / 2, rotated.height / 2);
    rctx.rotate((deg * Math.PI) / 180);
    rctx.drawImage(canvas, -width / 2, -height / 2);
    out = rotated;
  }

  const ow = out.width;
  const oh = out.height;
  if (maxDim > 0 && Math.max(ow, oh) > maxDim) {
    const scale = maxDim / Math.max(ow, oh);
    const w = Math.max(1, Math.round(ow * scale));
    const h = Math.max(1, Math.round(oh * scale));
    const scaled = new OffscreenCanvas(w, h);
    const sctx = scaled.getContext('2d');
    if (!sctx) throw new Error('OffscreenCanvas 2d 上下文不可用');
    sctx.drawImage(out, 0, 0, w, h);
    return await scaled.convertToBlob({ type: 'image/jpeg', quality });
  }
  return await out.convertToBlob({ type: 'image/jpeg', quality });
}
