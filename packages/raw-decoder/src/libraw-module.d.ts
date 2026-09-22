/**
 * libraw-wasm 内部产物的类型声明。
 * 我们不使用它的默认客户端(浏览器 Worker 封装),而是直接加载 emscripten
 * 工厂并注入 wasmBinary,以便在自管的 Worker 里运行。
 */
declare module 'libraw-wasm/dist/libraw.js' {
  export interface LibrawEmbindInstance {
    open(bytes: Uint8Array, settings?: Record<string, unknown>): Promise<void>;
    metadata(fullOutput?: boolean): Promise<Record<string, unknown> | undefined>;
    imageData(): Promise<{ width: number; height: number; colors: number; bits: number; data: Uint8Array } | undefined>;
    thumbnailData(): Promise<{ data: Uint8Array; width: number; height: number; format: string } | undefined>;
    delete(): void;
  }
  const createModule: (opts?: {
    wasmBinary?: ArrayBuffer;
    noInitialRun?: boolean;
  }) => Promise<{ LibRaw: new () => LibrawEmbindInstance }>;
  export default createModule;
}

declare module 'libraw-wasm/dist/libraw.wasm?url' {
  const url: string;
  export default url;
}
