// RAW/HEIF 查看派生 worker:完整解码 → JPEG Buffer。
// 独立于缩略图 worker 池:全解码可达数秒,不能占用共享池的并发槽位。
// 每个线程一次只处理一个任务(由主进程队列调度)。
//
// RAW 两种模式:
//   preview  内嵌预览 → JPEG(毫秒级,首次查看先显示它,消除黑屏等待);
//   full     完整解码(秒级,后台升级覆盖同一份派生文件)。
// HEIF 无独立内嵌预览可提取(libheif 完整解码本身即大头),两种模式共用
// 同一条 wasm 解码路径,仅按模式采用各自的限幅/质量(主进程对 HEIF 直接
// 走 full,不再发 preview)。
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { isHeifImage, openNodeRawSession } from './rawDecoder';
import { decodeHeifToRgba } from './heifDecoder';

// 派生图最长边上限:覆盖 8K 显示的 100% 查看,同时给超大中画幅
// (1 亿像素级)的解码/编码内存设界。
const MAX_DERIVATIVE_DIM = 8192;
// 预览级派生的上限:与 MAX_DERIVATIVE_DIM 一致,让多数机内全尺寸内嵌预览
// 不被降采样(相机直出模式的最终画面就是它)。
const MAX_PREVIEW_DIM = 8192;

export interface RawDerivativeJob {
  requestId: number;
  filePath: string;
  /** 缺省为 full(兼容旧主进程);preview 失败(无内嵌预览)以错误应答。 */
  mode?: 'preview' | 'full';
}

const flipToDeg: Record<number, number> = { 3: 180, 5: 270, 6: 90 };

async function generatePreviewDerivative(filePath: string): Promise<Uint8Array> {
  const raw = await readFile(filePath);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const session = await openNodeRawSession(bytes);
  try {
    const thumb = await session.thumbnail();
    if (!thumb) throw new Error('NO_EMBEDDED_PREVIEW');
    if (thumb.kind === 'jpeg') {
      // 尺寸达标时字节直通(零重编码、零降采样):显示的就是相机写入的那段
      // JPEG;EXIF 方向标记保留,由渲染端 <img> 按标记自动定向。
      if (Math.max(thumb.width, thumb.height) <= MAX_PREVIEW_DIM) {
        return thumb.data;
      }
      // 超限才重编码:.rotate() 按 EXIF 定向后再限幅缩放。
      const out = await sharp(Buffer.from(thumb.data), { failOn: 'none' })
        .rotate()
        .resize({ width: MAX_PREVIEW_DIM, height: MAX_PREVIEW_DIM, fit: 'inside' })
        .jpeg({ quality: 88 })
        .toBuffer();
      return new Uint8Array(out);
    }
    const out = await sharp(Buffer.from(thumb.data), { raw: { width: thumb.width, height: thumb.height, channels: 3 }, failOn: 'none' })
      .rotate(thumb.rotateDeg)
      .resize({ width: MAX_PREVIEW_DIM, height: MAX_PREVIEW_DIM, fit: 'inside' })
      .jpeg({ quality: 88 })
      .toBuffer();
    return new Uint8Array(out);
  } finally {
    session.close();
  }
}

async function generateFullDerivative(filePath: string): Promise<Uint8Array> {
  const raw = await readFile(filePath);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const session = await openNodeRawSession(bytes);
  try {
    const pixels = await session.pixels();
    const scale = Math.min(1, MAX_DERIVATIVE_DIM / Math.max(pixels.width, pixels.height));
    const width = Math.max(1, Math.round(pixels.width * scale));
    const height = Math.max(1, Math.round(pixels.height * scale));
    const out = await sharp(Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength), {
      raw: { width: pixels.width, height: pixels.height, channels: 3 },
    })
      .resize({ width, height, fit: 'inside' })
      .jpeg({ quality: 90 })
      .toBuffer();
    return new Uint8Array(out);
  } finally {
    session.close();
  }
}

async function generateHeifDerivative(filePath: string, maxDim: number, quality: number): Promise<Uint8Array> {
  const raw = await readFile(filePath);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const pixels = await decodeHeifToRgba(bytes);
  const scale = Math.min(1, maxDim / Math.max(pixels.width, pixels.height));
  const width = Math.max(1, Math.round(pixels.width * scale));
  const height = Math.max(1, Math.round(pixels.height * scale));
  const out = await sharp(Buffer.from(pixels.rgba.buffer, pixels.rgba.byteOffset, pixels.rgba.byteLength), {
    raw: { width: pixels.width, height: pixels.height, channels: 4 },
  })
    .resize({ width, height, fit: 'inside' })
    .jpeg({ quality })
    .toBuffer();
  return new Uint8Array(out);
}

if (parentPort) {
  parentPort.on('message', (job: RawDerivativeJob) => {
    void (async () => {
      try {
        const data = isHeifImage(job.filePath)
          ? await generateHeifDerivative(job.filePath, job.mode === 'preview' ? MAX_PREVIEW_DIM : MAX_DERIVATIVE_DIM, job.mode === 'preview' ? 88 : 90)
          : job.mode === 'preview'
            ? await generatePreviewDerivative(job.filePath)
            : await generateFullDerivative(job.filePath);
        parentPort?.postMessage({ requestId: job.requestId, ok: true, data }, [data.buffer as ArrayBuffer]);
      } catch (err) {
        parentPort?.postMessage({ requestId: job.requestId, ok: false, error: String((err as Error)?.message ?? err) });
      }
    })();
  });
}
