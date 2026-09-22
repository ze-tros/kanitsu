/**
 * RAW 解码会话(浏览器/WebView):把自管解码 worker 封装成与平台无关的
 * RawSession 接口。worker 生命周期 = 会话生命周期(close 即终止,连带释放
 * wasm 堆内存)。
 */
import type { RawPreview, RawPixels, RawSession } from '../decoder';
import { resolveRawDecodeOptions, toLibrawSettings, type RawDecodeOptions } from '../options';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const THUMB_FORMATS = ['unknown', 'jpeg', 'bitmap', 'bitmap16', 'layer', 'rollei', 'h265'] as const;

export async function openBrowserRawSession(bytes: Uint8Array, opts?: RawDecodeOptions): Promise<RawSession> {
  const resolved = resolveRawDecodeOptions(opts);
  const worker = new Worker(new URL('./rawWorker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, PendingCall>();
  let nextId = 0;

  worker.onmessage = (event: MessageEvent<{ id: number; out?: unknown; error?: string }>) => {
    const callItem = pending.get(event.data.id);
    if (!callItem) return;
    pending.delete(event.data.id);
    if (event.data.error !== undefined) callItem.reject(new Error(event.data.error));
    else callItem.resolve(event.data.out);
  };
  worker.onerror = (event) => {
    const err = new Error(event.message || 'RAW 解码 worker 异常');
    for (const callItem of pending.values()) callItem.reject(err);
    pending.clear();
  };

  function call<T>(fn: string, args: unknown[], transfer: ArrayBuffer[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, fn, args }, transfer);
    });
  }

  // 传入副本并转移所有权:调用方保留自己的 bytes,worker 侧零拷贝。
  const bytesCopy = bytes.slice();
  try {
    await call('open', [bytesCopy, toLibrawSettings(resolved)], [bytesCopy.buffer as ArrayBuffer]);
  } catch (err) {
    worker.terminate();
    throw err;
  }

  return {
    async thumbnail() {
      const thumb = await call<{ data: Uint8Array; width: number; height: number; format: string | number } | null>(
        'thumbnailData',
        [],
      );
      if (!thumb || !thumb.data || thumb.data.byteLength === 0 || !thumb.width || !thumb.height) return null;
      const fmt = typeof thumb.format === 'string' ? thumb.format : THUMB_FORMATS[Number(thumb.format)] ?? 'unknown';
      if (fmt === 'jpeg') {
        // jpeg 预览自带 EXIF 方向标记,直通/按 EXIF 定向即可,rotateDeg 恒 0。
        return { kind: 'jpeg', data: thumb.data, width: thumb.width, height: thumb.height, rotateDeg: 0 };
      }
      if (fmt === 'bitmap') {
        // 位图预览不带方向:从元数据取 flip 换算顺时针旋转角。
        let flip = 0;
        try {
          const meta = await call<Record<string, unknown> | null>('metadata', [false]);
          flip = Number(meta?.flip ?? 0);
        } catch {
          // 元数据失败按不旋转处理。
        }
        return {
          kind: 'rgb',
          data: thumb.data,
          width: thumb.width,
          height: thumb.height,
          rotateDeg: ({ 3: 180, 5: 270, 6: 90 } as Record<number, number>)[flip] ?? 0,
        };
      }
      return null;
    },
    async pixels() {
      const img = await call<{ width: number; height: number; data: Uint8Array } | null>('imageData', []);
      if (!img || !img.width || !img.height || !img.data) throw new Error('RAW 完整解码失败:无像素数据');
      return { data: img.data, width: img.width, height: img.height };
    },
    close() {
      for (const callItem of pending.values()) callItem.reject(new Error('RAW 会话已关闭'));
      pending.clear();
      worker.terminate();
    },
  };
}
