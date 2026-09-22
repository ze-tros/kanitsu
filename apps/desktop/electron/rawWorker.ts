// RAW 查看派生 worker:完整解码 RAW → JPEG Buffer。
// 独立于缩略图 worker 池:全解码可达数秒,不能占用共享池的并发槽位。
// 每个线程一次只处理一个任务(由主进程队列调度)。
//
// 两种模式:
//   preview  内嵌预览 → JPEG(毫秒级,首次查看先显示它,消除黑屏等待);
//   full     完整解码(秒级,后台升级覆盖同一份派生文件)。
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { openNodeRawSession } from './rawDecoder';

// 派生图最长边上限:覆盖 8K 显示的 100% 查看,同时给超大中画幅
// (1 亿像素级)的解码/编码内存设界。
const MAX_DERIVATIVE_DIM = 8192;
// 预览级派生的上限:相机内嵌预览通常 ≤ 全尺寸,4096 覆盖查看所需。
const MAX_PREVIEW_DIM = 4096;

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
      // 内嵌 JPEG 自带 EXIF 方向,.rotate() 定向后再限幅缩放。
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

if (parentPort) {
  parentPort.on('message', (job: RawDerivativeJob) => {
    void (async () => {
      try {
        const data = job.mode === 'preview'
          ? await generatePreviewDerivative(job.filePath)
          : await generateFullDerivative(job.filePath);
        parentPort?.postMessage({ requestId: job.requestId, ok: true, data }, [data.buffer as ArrayBuffer]);
      } catch (err) {
        parentPort?.postMessage({ requestId: job.requestId, ok: false, error: String((err as Error)?.message ?? err) });
      }
    })();
  });
}
