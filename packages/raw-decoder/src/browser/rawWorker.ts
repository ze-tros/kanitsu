/**
 * RAW 解码 Worker(浏览器/WebView)。
 * 每个解码会话对应一个 Worker 实例(由 client.ts 创建/终止);
 * 加载 emscripten 工厂并注入 wasmBinary(fetch 自 Vite 资产 URL),
 * 不依赖 libraw-wasm 默认客户端的内部 worker 与相对路径 wasm 加载。
 */
import createModule, { type LibrawEmbindInstance } from 'libraw-wasm/dist/libraw.js';
import wasmUrl from 'libraw-wasm/dist/libraw.wasm?url';

type WorkerInbound = { id: number; fn: string; args: unknown[] };

let instancePromise: Promise<LibrawEmbindInstance> | null = null;

function getInstance(): Promise<LibrawEmbindInstance> {
  if (!instancePromise) {
    instancePromise = (async () => {
      const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
      const mod = await createModule({ wasmBinary, noInitialRun: true });
      return new mod.LibRaw();
    })();
    instancePromise.catch(() => {
      instancePromise = null;
    });
  }
  return instancePromise;
}

/** 收集结果里的 typed array buffer 用于零拷贝转移。 */
function collectTransferables(value: unknown): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (ArrayBuffer.isView(v) && !(v instanceof DataView) && (v.buffer as ArrayBuffer) instanceof ArrayBuffer) {
        out.push(v.buffer as ArrayBuffer);
      }
    }
  }
  return out;
}

self.onmessage = async (event: MessageEvent<WorkerInbound>) => {
  const { id, fn, args } = event.data;
  try {
    const inst = await getInstance();
    const method = (inst as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[fn];
    if (typeof method !== 'function') throw new Error(`未知方法:${fn}`);
    const out = method.apply(inst, args);
    (self as unknown as Worker).postMessage({ id, out }, collectTransferables(out));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
