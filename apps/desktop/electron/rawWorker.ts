// RAW 查看派生 worker:完整解码 RAW → JPEG Buffer。
// 独立于缩略图 worker 池:全解码可达数秒,不能占用共享池的并发槽位。
// 每个线程一次只处理一个任务(由主进程队列调度)。
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { openNodeRawSession } from './rawDecoder';

// 派生图最长边上限:覆盖 8K 显示的 100% 查看,同时给超大中画幅
// (1 亿像素级)的解码/编码内存设界。
const MAX_DERIVATIVE_DIM = 8192;

export interface RawDerivativeJob {
  requestId: number;
  filePath: string;
}

async function generateDerivative(filePath: string): Promise<Uint8Array> {
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
        const data = await generateDerivative(job.filePath);
        parentPort?.postMessage({ requestId: job.requestId, ok: true, data }, [data.buffer as ArrayBuffer]);
      } catch (err) {
        parentPort?.postMessage({ requestId: job.requestId, ok: false, error: String((err as Error)?.message ?? err) });
      }
    })();
  });
}
