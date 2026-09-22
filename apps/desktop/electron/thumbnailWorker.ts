// Worker thread：缩略图生成。nativeImage 只能在主进程使用，且解码大图会长时间
// 阻塞主进程事件循环（UI/IPC 全被拖慢）。缩略图解码/缩放/编码全部放到 worker
// 线程，主进程只做缓存与调度。主路径是 sharp（libvips，Node-API 原生库，与
// Electron ABI 兼容），支持 jpeg/png/webp/avif/bmp；sharp 解析失败的少见文件
// 由主进程 nativeImage 兜底（见 main.ts，文件会进黑名单避免反复尝试）。
// GIF 网格缩略图也走 sharp 的单帧输出；原始动画只在查看器中播放。
// RAW 走 libraw 内嵌预览提取，HEIF/HEIC 走 libheif wasm 完整解码（sharp 的
// libvips 预编译不含 HEVC 解码器）。
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { GifReader, GifWriter } from 'omggif';
import { isHeifImage, isRawImage, openNodeRawSession } from './rawDecoder';
import { decodeHeifToRgba } from './heifDecoder';

// 多个 worker 已提供图片级并行；限制每条 libvips 管线为单线程，避免 CPU 过度订阅。
sharp.concurrency(1);

export interface ThumbnailJob {
  requestId: number;
  filePath: string;
  targetSize: number;
}

export function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx < 0 ? '' : name.slice(idx + 1).toLowerCase();
}

/** sharp 流水线：解码 → 等比缩小（最长边 ≤ targetSize）→ JPEG 80。
 *  输入先整份读进内存再交给 libvips：libvips 按路径打开文件时不带共享删除语义，
 *  解码期间该文件在 Windows 上删不掉也改不了名（整库预热/网格刷新一旦与删除撞在
 *  同一张图上就 EPERM）。经 Buffer 输入的句柄是 libuv 的（允许共享删除），解不解
 *  码都不再挡住用户操作；与 RAW/HEIF 分支的读取方式也保持一致。 */
export async function generateThumbnailWithSharp(filePath: string, targetSize: number): Promise<Uint8Array> {
  const input = await readFile(filePath);
  const image = sharp(input, { failOn: 'none' });
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('无法读取图像尺寸');
  const scale = Math.min(1, targetSize / Math.max(width, height));
  const out = await image
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      fit: 'inside',
    })
    .jpeg({ quality: 80 })
    .toBuffer();
  return new Uint8Array(out);
}

// —— 动画 GIF 缩略图（omggif，纯 JS）——
// 大 GIF 不再整包透传（体积可达数 MB，还会挤垮内存/磁盘缓存）：抽帧 → 缩放 →
// 重编码为“可动且小”的 GIF。帧数采样封顶控制单张耗时（基准：20 帧约 0.47s，
// 封顶后典型约 0.1~0.3s，且只发生一次并落盘缓存）。
// 色彩：使用自适应调色板（median-cut，≤255 色）保留原图真实颜色，避免固定
// web 安全色板导致的大幅色偏；gif 编码显式 loop:0 保证无限循环播放。
const GIF_MAX_FRAMES = 16;
const GIF_MAX_OUTPUT_BYTES = 1536 * 1024; // 超出则降帧重编码一次
const GifTransparentIndex = 255;
const BUCKET_SHIFT = 3; // 5-bit 桶（每通道 32 级），用于直方图中位切分

/** 取桶的中位 8bit 色（桶下界 + 4）。 */
function bucketMidRgb(bucket: number): [number, number, number] {
  return [((bucket >> 10) & 31) << BUCKET_SHIFT | 4, ((bucket >> 5) & 31) << BUCKET_SHIFT | 4, (bucket & 31) << BUCKET_SHIFT | 4];
}

/** 基于所有帧构建自适应调色板（median-cut）+ 桶→调色板索引映射。 */
function buildAdaptivePalette(frames: Uint8Array[], w: number, h: number): { palette: number[]; bucketMap: Uint8Array } {
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
function quantizeToIndex(rgba: Uint8Array, w: number, h: number, bucketMap: Uint8Array): Uint8Array {
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
function resizeRgba(src: Uint8Array, sw: number, sh: number, targetSize: number): { data: Uint8Array; width: number; height: number } {
  const scale = Math.min(1, targetSize / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  if (width === sw && height === sh) return { data: src, width, height };
  const out = new Uint8Array(width * height * 4);
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
function clearRect(px: Uint8Array, canvasW: number, canvasH: number, x: number, y: number, w: number, h: number): void {
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

/** 解码 GIF（逐帧顺序合成 + disposal；仅在采样帧截取），返回缩放后的 RGBA 帧列表。 */
function decodeGifFrames(buf: Buffer, targetSize: number, maxFrames: number): { frames: Uint8Array[]; delays: number[]; width: number; height: number } {
  const reader = new GifReader(buf);
  const W = reader.width;
  const H = reader.height;
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
      frames.push(composite.slice());
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
    frames.push(composite.slice());
    delays.push(10);
  }
  const scaled = frames.map((rgba) => resizeRgba(rgba, W, H, targetSize));
  return { frames: scaled.map((f) => f.data), delays, width: scaled[0]?.width ?? 0, height: scaled[0]?.height ?? 0 };
}

/** 编码为动画 GIF 字节：自适应调色板 + 显式无限循环（loop: 0）。 */
function encodeFrames(frames: Uint8Array[], delays: number[], width: number, height: number): Buffer {
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

/** 动画 GIF 缩略图（可动 + 小）；超限时降帧重编码一次。 */
export async function generateAnimatedGifThumb(filePath: string, targetSize: number): Promise<Uint8Array> {
  const buf = await readFile(filePath);
  let { frames, delays, width, height } = decodeGifFrames(buf, targetSize, GIF_MAX_FRAMES);
  let out = encodeFrames(frames, delays, width, height);
  if (out.byteLength > GIF_MAX_OUTPUT_BYTES) {
    // 输出太大：把帧数减半重编一次
    const half = frames.length <= 4 ? frames.length : Math.max(4, Math.floor(frames.length / 2));
    const step = Math.max(1, Math.floor(frames.length / half));
    const idxs: number[] = [];
    for (let k = 0; k < half; k++) idxs.push(Math.min(frames.length - 1, k * step));
    frames = idxs.map((i) => frames[i]!);
    delays = idxs.map((i) => delays[i]!);
    out = encodeFrames(frames, delays, width, height);
  }
  return new Uint8Array(out);
}

// —— RAW 缩略图（libraw 内嵌预览优先）——
// 相机 RAW 普遍内嵌机内全尺寸 JPEG 预览，提取是毫秒级；仅在无内嵌预览时
// （部分 DNG/老机型）回退完整解码，并用 halfSize 控制耗时。
// 方向：竖拍 RAW 的预览多为「横置像素 + EXIF 方向标记」，重编码会丢标记，
// 因此 jpeg 预览必须 .rotate() 按 EXIF 自动定向；rgb 位图预览无 EXIF，
// 由会话给出 flip 换算的旋转角。
async function sharpResizeToJpeg(
  input: Buffer,
  targetSize: number,
  opts?: { raw?: { width: number; height: number; channels: 3 | 4 }; rotateDeg?: number },
): Promise<Uint8Array> {
  const raw = opts?.raw;
  const image = sharp(input, { raw, failOn: 'none' });
  const meta = raw ? undefined : await image.metadata();
  const width = raw?.width ?? meta?.width ?? 0;
  const height = raw?.height ?? meta?.height ?? 0;
  if (!width || !height) throw new Error('无法读取图像尺寸');
  // 旋转后才是显示宽高:显式 rotateDeg(90/270)或 EXIF orientation 5-8 都会交换宽高,
  // 缩放目标框必须按旋转后的尺寸计算,否则竖图被塞进横框、长边缩水。
  const exifOrientation = meta?.orientation ?? 1;
  const swapped = opts?.rotateDeg === 90 || opts?.rotateDeg === 270 || (!raw && exifOrientation >= 5 && exifOrientation <= 8);
  const displayW = swapped ? height : width;
  const displayH = swapped ? width : height;
  const finalScale = Math.min(1, targetSize / Math.max(displayW, displayH));
  const pipeline = sharp(input, { raw, failOn: 'none' });
  if (raw) {
    // 位图预览：无 EXIF，按会话给出的 flip 旋转角定向。
    if (opts?.rotateDeg) pipeline.rotate(opts.rotateDeg);
  } else {
    // jpeg 预览：按 EXIF 方向自动定向（无标记时无操作），随后标记被剥离。
    pipeline.rotate();
  }
  const out = await pipeline
    .resize({
      width: Math.max(1, Math.round(displayW * finalScale)),
      height: Math.max(1, Math.round(displayH * finalScale)),
      fit: 'inside',
    })
    .jpeg({ quality: 80 })
    .toBuffer();
  return new Uint8Array(out);
}

async function generateRawThumbnail(filePath: string, targetSize: number): Promise<Uint8Array> {
  const raw = await readFile(filePath);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  let session = await openNodeRawSession(bytes);
  try {
    const thumb = await session.thumbnail();
    if (thumb?.kind === 'jpeg') {
      return await sharpResizeToJpeg(Buffer.from(thumb.data), targetSize);
    }
    if (thumb?.kind === 'rgb') {
      return await sharpResizeToJpeg(Buffer.from(thumb.data), targetSize, {
        raw: {
          width: thumb.width,
          height: thumb.height,
          channels: 3,
        },
        rotateDeg: thumb.rotateDeg,
      });
    }
    // 无内嵌预览：重新以 halfSize 打开，完整解码后缩放（会话的解码设置在
    // open 时固定，因此必须重开会话）。
    session.close();
    session = await openNodeRawSession(bytes, { halfSize: true });
    const pixels = await session.pixels();
    return await sharpResizeToJpeg(Buffer.from(pixels.data), targetSize, {
      raw: {
        width: pixels.width,
        height: pixels.height,
        channels: 3,
      },
    });
  } finally {
    session.close();
  }
}

/** 完整流水线：所有格式均输出单帧 JPEG 缩略图。 */
export async function generateThumbnailFromFile(filePath: string, targetSize: number): Promise<Uint8Array> {
  if (isRawImage(filePath)) {
    return generateRawThumbnail(filePath, targetSize);
  }
  if (isHeifImage(filePath)) {
    return generateHeifThumbnail(filePath, targetSize);
  }
  return generateThumbnailWithSharp(filePath, targetSize);
}

// —— HEIF/HEIC 缩略图（libheif wasm）——
// sharp 的 libvips 预编译不含 HEVC 解码器，HEIF 由 libheif 完整解码出 RGBA
// （libheif-js 的高级 API 只解主图；相机内嵌缩略图 item 的加速可后续优化），
// 再交 sharp 限幅缩放编码。25MP 解码约 2~3s，主进程对该类任务放宽了超时。
async function generateHeifThumbnail(filePath: string, targetSize: number): Promise<Uint8Array> {
  const raw = await readFile(filePath);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const pixels = await decodeHeifToRgba(bytes);
  return await sharpResizeToJpeg(Buffer.from(pixels.rgba.buffer, pixels.rgba.byteOffset, pixels.rgba.byteLength), targetSize, {
    raw: { width: pixels.width, height: pixels.height, channels: 4 },
  });
}

// —— worker 消息循环（仅在线程内生效；作为库调用时跳过）——
if (parentPort) {
  parentPort.on('message', (job: ThumbnailJob) => {
    void (async () => {
      try {
        const data = await generateThumbnailFromFile(job.filePath, job.targetSize);
        parentPort?.postMessage({ requestId: job.requestId, ok: true, data });
      } catch (err) {
        parentPort?.postMessage({ requestId: job.requestId, ok: false, error: String((err as Error)?.message ?? err) });
      }
    })();
  });
}
