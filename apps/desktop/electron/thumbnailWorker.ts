// Worker thread：缩略图生成。nativeImage 只能在主进程使用，且解码大图会长时间
// 阻塞主进程事件循环（UI/IPC 全被拖慢）。缩略图解码/缩放/编码全部放到 worker
// 线程，主进程只做缓存与调度。主路径是 sharp（libvips，Node-API 原生库，与
// Electron ABI 兼容），支持 jpeg/png/webp/avif/bmp；sharp 解析失败的少见文件
// 由主进程 nativeImage 兜底（见 main.ts，文件会进黑名单避免反复尝试）。
import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';

export interface ThumbnailJob {
  requestId: number;
  filePath: string;
  targetSize: number;
}

/** sharp 流水线：解码 → 等比缩小（最长边 ≤ targetSize）→ JPEG 80。 */
export async function generateThumbnailFromFile(filePath: string, targetSize: number): Promise<Uint8Array> {
  const image = sharp(filePath, { failOn: 'none' });
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