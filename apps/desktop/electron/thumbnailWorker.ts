// Worker thread：缩略图生成。nativeImage 只能在主进程使用，且解码大图会长时间
// 阻塞主进程事件循环（UI/IPC 全被拖慢）。缩略图解码/缩放/编码全部放到 worker
// 线程，主进程只做缓存与调度。主路径是 sharp（libvips，Node-API 原生库，与
// Electron ABI 兼容），支持 jpeg/png/webp/avif/bmp；sharp 解析失败的少见文件
// 由主进程 nativeImage 兜底（见 main.ts，文件会进黑名单避免反复尝试）。
// GIF 网格缩略图优先生成「可动且小」的动画 GIF（omggif 抽帧重编码，见下）；
// 超大源或编码失败回退 sharp 静态首帧。原始高清动画只在查看器中播放。
// RAW 走 libraw 内嵌预览提取，HEIF/HEIC 优先解容器内嵌缩略图 item（毫秒级，
// 无合格 item 时回退主图完整解码；sharp 的 libvips 预编译不含 HEVC 解码器）。
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { isHeifImage, isRawImage, openNodeRawSession } from './rawDecoder';
import { decodeHeifEmbeddedToRgba, decodeHeifToRgba } from './heifDecoder';

// 多个 worker 已提供图片级并行；限制每条 libvips 管线为单线程，避免 CPU 过度订阅。
sharp.concurrency(1);

export interface ThumbnailJob {
  requestId: number;
  filePath: string;
  targetSize: number;
  /** 仅 GIF 有意义：动画 / 静态首帧（其余格式忽略）。 */
  gifAnimated?: boolean;
}

export function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx < 0 ? '' : name.slice(idx + 1).toLowerCase();
}

export async function generateThumbnailWithSharp(filePath: string, targetSize: number): Promise<Uint8Array> {
  return generateThumbnailFromBuffer(await readFile(filePath), targetSize);
}

/** sharp 流水线（Buffer 输入）：解码 → 等比缩小（最长边 ≤ targetSize）→ JPEG 80。
 *  输入先整份读进内存再交给 libvips：libvips 按路径打开文件时不带共享删除语义，
 *  解码期间该文件在 Windows 上删不掉也改不了名（整库预热/网格刷新一旦与删除撞在
 *  同一张图上就 EPERM）。经 Buffer 输入的句柄是 libuv 的（允许共享删除），解不解
 *  码都不再挡住用户操作；与 RAW/HEIF 分支的读取方式也保持一致。 */
export async function generateThumbnailFromBuffer(input: Buffer, targetSize: number): Promise<Uint8Array> {
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
// 网格里的 GIF 目标是「可动且小」：抽帧 → 缩放 → 重编码为小体积动画 GIF，
// 输出典型几百 KB，远小于原始文件。帧数采样封顶控制单张耗时（基准：20 帧约
// 0.47s，封顶后典型约 0.1~0.3s，且只发生一次并落盘缓存）。
// 色彩：使用自适应调色板（median-cut，≤255 色）保留原图真实颜色，避免固定
// web 安全色板导致的大幅色偏；gif 编码显式 loop:0 保证无限循环播放。
// 超大源不做抽帧：逐帧合成解码的耗时/内存随帧数与尺寸增长，容易拖垮
// worker，直接回退静态首帧；动画编码失败同样回退，网格上不出坏图。
// 量化/缩放/编解码的纯逻辑在 gifQuantize.ts（可单测）。
import { decodeGifFrames, encodeFrames, GIF_MAX_FRAMES, GIF_MAX_OUTPUT_BYTES } from './gifQuantize';

/** 动画 GIF 缩略图（可动 + 小）；超限时降帧重编码一次。 */
export async function generateAnimatedGifThumb(buf: Buffer, targetSize: number): Promise<Uint8Array> {
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

/** 超过该字节数的 GIF 不做抽帧动画：逐帧合成解码的耗时/内存随帧数与尺寸
 *  增长，超大源（罕见）直接走静态首帧，别让个别文件拖垮 worker 线程。 */
const GIF_ANIMATED_SOURCE_MAX_BYTES = 24 * 1024 * 1024;

/** GIF 网格缩略图：动画模式优先（抽帧重编码），静态模式 / 超大源 / 编码失败回退静态首帧。 */
export async function generateGifThumbnail(filePath: string, targetSize: number, animated: boolean): Promise<Uint8Array> {
  const buf = await readFile(filePath);
  if (animated && buf.byteLength <= GIF_ANIMATED_SOURCE_MAX_BYTES) {
    try {
      return await generateAnimatedGifThumb(buf, targetSize);
    } catch {
      // 动画编码失败：回退静态首帧，网格上不出坏图。
    }
  }
  return generateThumbnailFromBuffer(buf, targetSize);
}

/** 完整流水线（GIF 按模式走动画/静态分支，其余格式均输出单帧 JPEG 缩略图）。 */
export async function generateThumbnailFromFile(
  filePath: string,
  targetSize: number,
  gifAnimated = true,
): Promise<Uint8Array> {
  if (extOf(filePath) === 'gif') {
    return generateGifThumbnail(filePath, targetSize, gifAnimated);
  }
  if (isRawImage(filePath)) {
    return generateRawThumbnail(filePath, targetSize);
  }
  if (isHeifImage(filePath)) {
    return generateHeifThumbnail(filePath, targetSize);
  }
  return generateThumbnailWithSharp(filePath, targetSize);
}

// —— HEIF/HEIC 缩略图（libheif wasm）——
// sharp 的 libvips 预编译不含 HEVC 解码器，HEIF 由 libheif 解码出 RGBA 再交
// sharp 限幅缩放编码。优先解容器内嵌的缩略图/预览 item（毫秒级；清晰度下限
// 取 targetSize/3，覆盖 iPhone 类 240px 内嵌缩略图，允许网格卡片上 ≤2x 放大）；
// 无合格 item（或像部分 Sony HIF 那样内嵌 item 被 libheif 的 ispe 一致性校验
// 拒绝）时回退主图完整解码（25MP 约 2~3s，主进程对该类任务放宽了超时）。
async function generateHeifThumbnail(filePath: string, targetSize: number): Promise<Uint8Array> {
  const raw = await readFile(filePath);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const minLongEdge = Math.max(192, Math.ceil(targetSize / 3));
  const embedded = await decodeHeifEmbeddedToRgba(bytes, minLongEdge).catch(() => null);
  const pixels = embedded ?? (await decodeHeifToRgba(bytes));
  return await sharpResizeToJpeg(Buffer.from(pixels.rgba.buffer, pixels.rgba.byteOffset, pixels.rgba.byteLength), targetSize, {
    raw: { width: pixels.width, height: pixels.height, channels: 4 },
  });
}

// —— worker 消息循环（仅在线程内生效；作为库调用时跳过）——
if (parentPort) {
  parentPort.on('message', (job: ThumbnailJob) => {
    void (async () => {
      try {
        const data = await generateThumbnailFromFile(job.filePath, job.targetSize, job.gifAnimated !== false);
        parentPort?.postMessage({ requestId: job.requestId, ok: true, data });
      } catch (err) {
        parentPort?.postMessage({ requestId: job.requestId, ok: false, error: String((err as Error)?.message ?? err) });
      }
    })();
  });
}
