// 动画 GIF 缩略图的自研纯逻辑（omggif 解码 + median-cut 量化 + 双线性缩放），
// 从 thumbnailWorker 抽出：不依赖 sharp / worker 线程，可被 node:test 直接单测
// （全透明图、单色图、1×1 目标、单帧 GIF 等分支最容易静默出错）。
import { GifReader, GifWriter } from 'omggif';

export const GIF_MAX_FRAMES = 16;
/** 超出则降帧重编码一次 */
export const GIF_MAX_OUTPUT_BYTES = 1536 * 1024;
export const GifTransparentIndex = 255;
/** 5-bit 桶（每通道 32 级），用于直方图中位切分 */
export const BUCKET_SHIFT = 3;
/** GIF 逻辑画布像素上限：逻辑屏幕描述符是 u16，恶意/损坏文件可声明 65535×65535，
 *  不设上限会让 composite 一次性申请十几 GB 拖垮 worker。8K×4K 量级足够覆盖合法 GIF。 */
export const GIF_MAX_CANVAS_PIXELS = 33_177_600;

/** 取桶的中位 8bit 色（桶下界 + 4）。 */
function bucketMidRgb(bucket: number): [number, number, number] {
  return [((bucket >> 10) & 31) << BUCKET_SHIFT | 4, ((bucket >> 5) & 31) << BUCKET_SHIFT | 4, (bucket & 31) << BUCKET_SHIFT | 4];
}

/** 基于所有帧构建自适应调色板（median-cut）+ 桶→调色板索引映射。 */
export function buildAdaptivePalette(frames: Uint8Array[], w: number, h: number): { palette: number[]; bucketMap: Uint8Array } {
  const HIST = 32768;
  const hist = new Int32Array(HIST);
  for (const frame of frames) {
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      if (frame[i + 3]! >= 128) {
        const bucket = ((frame[i]! >> BUCKET_SHIFT) << 10) | ((frame[i + 1]! >> BUCKET_SHIFT) << 5) | (frame[i + 2]! >> BUCKET_SHIFT);
        hist[bucket]++;
      }
    }
  }
  const occupied: number[] = [];
  for (let b = 0; b < HIST; b++) if (hist[b]! > 0) occupied.push(b);
  if (occupied.length === 0) {
    const palette = new Array<number>(256).fill(0);
    return { palette, bucketMap: new Uint8Array(HIST) };
  }
  const coord = (bucket: number, c: number): number => (c === 0 ? (bucket >> 10) : c === 1 ? (bucket >> 5) & 31 : bucket & 31) & 31;

  // median-cut：把桶集合切成 ≤255 个盒子，按像素量取最重的可切盒子、在跨度最大
  // 通道的累计中位处切开。
  interface Box { buckets: number[] }
  const boxes: Box[] = [{ buckets: occupied }];
  const MAX_COLORS = 255; // 预留 255 给透明
  while (boxes.length < MAX_COLORS) {
    let best = -1;
    let bestBoxIdx = -1;
    let bestChannel = 0;
    for (let i = 0; i < boxes.length; i++) {
      const boxBuckets = boxes[i]!.buckets;
      const min = [31, 31, 31];
      const max = [0, 0, 0];
      let pixels = 0;
      let bestDistinct = -1;
      let bestSpan = -1;
      for (const b of boxBuckets) {
        for (let c = 0; c < 3; c++) {
          const v = coord(b, c);
          if (v < min[c]!) min[c] = v;
          if (v > max[c]!) max[c] = v;
        }
        pixels += hist[b]!;
      }
      for (let c = 0; c < 3; c++) {
        const span = max[c]! - min[c]!;
        // 该通道的相异坐标数（若为 1 则不可切）
        const seen = new Set<number>();
        for (const b of boxBuckets) seen.add(coord(b, c));
        const distinct = seen.size;
        if (span > bestSpan && distinct >= 2) {
          bestSpan = span;
          bestDistinct = distinct;
        }
      }
      if (bestDistinct >= 2 && pixels > best) {
        best = pixels;
        bestBoxIdx = i;
        bestChannel = -1;
        // 从三个通道里选跨度最大且可切者
        let pickSpan = -1;
        for (let c = 0; c < 3; c++) {
          const span = max[c]! - min[c]!;
          const seen = new Set<number>();
          for (const b of boxBuckets) seen.add(coord(b, c));
          if (seen.size >= 2 && span > pickSpan) {
            pickSpan = span;
            bestChannel = c;
          }
        }
      }
    }
    if (bestBoxIdx < 0) break;
    const box = boxes[bestBoxIdx]!;
    // 在该通道的相异坐标间按累计像素中位切分（保证两侧非空）
    const coordCounts = new Map<number, number>();
    for (const b of box.buckets) {
      const v = coord(b, bestChannel);
      coordCounts.set(v, (coordCounts.get(v) ?? 0) + hist[b]!);
    }
    const vals = [...coordCounts.keys()].sort((a, b) => a - b);
    if (vals.length < 2) break;
    let total = box.buckets.reduce((n, b) => n + hist[b]!, 0);
    let acc = 0;
    let idx = 0;
    for (; idx < vals.length; idx++) {
      acc += coordCounts.get(vals[idx]!)!;
      if (acc * 2 >= total) break;
    }
    // 过半档若在第 0 档（头档独占过半像素），仍应在其与下一档之间切分
    const j = Math.max(1, idx);
    if (j >= vals.length) break;
    const cutMid = (vals[j - 1]! + vals[j]!) / 2;
    const a: number[] = [];
    const d: number[] = [];
    for (const b of box.buckets) (coord(b, bestChannel) <= cutMid ? a : d).push(b);
    if (a.length === 0 || d.length === 0) break;
    boxes.splice(bestBoxIdx, 1, { buckets: a }, { buckets: d });
  }

  // 盒子 → 加权平均色
  const paletteRgb: [number, number, number][] = [];
  for (const box of boxes) {
    let r = 0, g = 0, b = 0, n = 0;
    for (const bk of box.buckets) {
      const c = hist[bk]!;
      const [rr, gg, bb] = bucketMidRgb(bk);
      r += rr * c;
      g += gg * c;
      b += bb * c;
      n += c;
    }
    if (n === 0) continue;
    paletteRgb.push([(r / n) | 0, (g / n) | 0, (b / n) | 0]);
  }
  const palette: number[] = [];
  // omggif 的 GifWriter 写调色板条目时“高位在前”（byte0 = 打包 int 的高字节），
  // 因此按 b|g<<8|r<<16 打包才能在表中呈现规范 R,G,B 顺序。
  for (const [r, g, b] of paletteRgb) palette.push(b | (g << 8) | (r << 16));
  while (palette.length < 256) palette.push(0); // omggif 要求 2 的幂

  // 每个出现过的桶 → 最近调色板色
  const bucketMap = new Uint8Array(HIST);
  for (const b of occupied) {
    const [mr, mg, mb] = bucketMidRgb(b);
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < paletteRgb.length; i++) {
      const [pr, pg, pb] = paletteRgb[i]!;
      const dr = mr - pr;
      const dg = mg - pg;
      const db = mb - pb;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    bucketMap[b] = bestIdx;
  }
  return { palette, bucketMap };
}

/** RGBA → 调色板索引（透明用 255）。 */
export function quantizeToIndex(rgba: Uint8Array, w: number, h: number, bucketMap: Uint8Array): Uint8Array {
  const idx = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (rgba[i + 3]! < 128) {
      idx[p] = GifTransparentIndex;
      continue;
    }
    const bucket = ((rgba[i]! >> BUCKET_SHIFT) << 10) | ((rgba[i + 1]! >> BUCKET_SHIFT) << 5) | (rgba[i + 2]! >> BUCKET_SHIFT);
    idx[p] = bucketMap[bucket]!;
  }
  return idx;
}

/** RGBA 双线性缩放（等比，最长边 ≤ targetSize）。 */
export function resizeRgba(src: Uint8Array, sw: number, sh: number, targetSize: number): { data: Uint8Array; width: number; height: number } {
  const scale = Math.min(1, targetSize / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  if (width === sw && height === sh) return { data: src, width, height };
  const out = new Uint8Array(width * height * 4);
  // 0 尺寸源没有可采样像素：直接返回透明底，别让 undefined 采样点算出 NaN 再静默变 0。
  if (sw <= 0 || sh <= 0 || src.length === 0) return { data: out, width, height };
  for (let y = 0; y < height; y++) {
    const sy = ((y + 0.5) * sh) / height - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = ((x + 0.5) * sw) / width - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const di = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(y0 * sw + x0) * 4 + c]!;
        const p10 = src[(y0 * sw + x1) * 4 + c]!;
        const p01 = src[(y1 * sw + x0) * 4 + c]!;
        const p11 = src[(y1 * sw + x1) * 4 + c]!;
        out[di + c] = Math.round(p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy);
      }
    }
  }
  return { data: out, width, height };
}

/** 清空画布上某矩形区域（恢复为透明背景，用于 disposal=2）。 */
export function clearRect(px: Uint8Array, canvasW: number, canvasH: number, x: number, y: number, w: number, h: number): void {
  const x0 = Math.max(0, Math.min(canvasW, x));
  const y0 = Math.max(0, Math.min(canvasH, y));
  const x1 = Math.max(0, Math.min(canvasW, x + w));
  const y1 = Math.max(0, Math.min(canvasH, y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * canvasW + xx) * 4;
      px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
    }
  }
}

/** 解码 GIF（逐帧顺序合成 + disposal；仅在采样帧截取），返回缩放后的 RGBA 帧列表。
 *  采样帧在合成后立即缩放：峰值内存 = 合成画布 + 单帧拷贝 + 缩放后帧，
 *  而不是「全部采样帧的全尺寸拷贝」。 */
export function decodeGifFrames(buf: Buffer, targetSize: number, maxFrames: number): { frames: Uint8Array[]; delays: number[]; width: number; height: number } {
  const reader = new GifReader(buf);
  const W = reader.width;
  const H = reader.height;
  if (W <= 0 || H <= 0 || W * H > GIF_MAX_CANVAS_PIXELS) {
    throw new Error(`GIF 画布尺寸异常：${W}×${H}`);
  }
  const total = reader.numFrames();
  const count = Math.max(1, Math.min(maxFrames, total));
  // 采样下标：均匀且含首尾帧；采样倍率 = 每个采样帧代表的原帧数
  const sampled = new Set<number>();
  if (count <= 1) {
    sampled.add(0);
  } else {
    for (let k = 0; k < count; k++) sampled.add(Math.round((k * (total - 1)) / (count - 1)));
  }
  const stride = Math.max(1, (total - 1) / Math.max(1, count - 1));

  // 逐帧合成：decodeAndBlitFrameRGBA 按帧内透明像素叠加，disposal 由我们处理，
  // 保证稀疏采样时画布状态与原始动画一致（避免白底等透明动画的残影）。
  const composite = new Uint8Array(W * H * 4);
  const frames: Uint8Array[] = [];
  const delays: number[] = [];
  let outW = 0;
  let outH = 0;
  for (let i = 0; i < total; i++) {
    const info = reader.frameInfo(i);
    const runtime = info as unknown as { disposal_type?: number };
    // omggif 的 frameInfo().delay 单位是厘秒（1/100 秒）
    const delayCs = info.delay ?? 6;
    const disposalType = runtime.disposal_type ?? info.disposal;
    const before = disposalType === 3 ? composite.slice() : null; // 还原前一帧
    reader.decodeAndBlitFrameRGBA(i, composite);
    if (sampled.has(i)) {
      // 延迟按采样倍率放大，保持与原动画相同的循环时长（采样少 → 不再过快）
      delays.push(Math.max(1, Math.min(250, Math.round(delayCs * stride))));
      const scaled = resizeRgba(composite.slice(), W, H, targetSize);
      if (outW === 0) {
        outW = scaled.width;
        outH = scaled.height;
      }
      frames.push(scaled.data);
    }
    if (disposalType === 2) {
      // 恢复背景：清掉该帧矩形（透明）
      clearRect(composite, W, H, info.x, info.y, info.width, info.height);
    } else if (disposalType === 3 && before) {
      composite.set(before);
    }
  }
  if (frames.length === 0) {
    // 理论上不会发生（total ≥ 1）
    const scaled = resizeRgba(composite.slice(), W, H, targetSize);
    frames.push(scaled.data);
    delays.push(10);
    outW = scaled.width;
    outH = scaled.height;
  }
  return { frames, delays, width: outW, height: outH };
}

/** 编码为动画 GIF 字节：自适应调色板 + 显式无限循环（loop: 0）。 */
export function encodeFrames(frames: Uint8Array[], delays: number[], width: number, height: number): Buffer {
  const { palette, bucketMap } = buildAdaptivePalette(frames, width, height);
  const capacity = width * height * frames.length + 65536 + (frames.length + 1) * 8 * 1024;
  const out = Buffer.alloc(capacity);
  const gif = new GifWriter(out, width, height, { palette, loop: 0 });
  for (let f = 0; f < frames.length; f++) {
    const idx = quantizeToIndex(frames[f]!, width, height, bucketMap);
    gif.addFrame(0, 0, width, height, idx as unknown as number[], { palette, delay: delays[f], transparent: GifTransparentIndex });
  }
  gif.end();
  return out.subarray(0, gif.end());
}
