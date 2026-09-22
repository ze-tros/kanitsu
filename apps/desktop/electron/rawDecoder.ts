// RAW 解码:在 Node 线程内直接加载 libraw-wasm 的 emscripten 模块。
//
// libraw-wasm 的默认入口(dist/index.js)面向浏览器(内部 new Worker,
// 无 Node 回退)。这里绕开它,直接加载 dist/libraw.js(工厂函数,导出
// LibRaw 类)并以 wasmBinary 注入,使其在同一线程内运行——调用方
// (缩略图 worker / RAW 派生 worker)本身就是专用线程,阻塞无害。
//
// 解码管线(libraw dcraw_process):demosaic → 白平衡(useCameraWb)
// → sRGB → 8bit RGB,输出已按相机方向(flip)旋转。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 首期支持的主流相机 RAW 扩展名(规范来源 packages/core/src/path.ts;
 * 桌面主进程受 tsc rootDir 限制无法跨包引用,此处独立维护)。 */
export const RAW_IMAGE_EXT = new Set([
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
]);

export function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx < 0 ? '' : name.slice(idx + 1).toLowerCase();
}

export function isRawImage(name: string): boolean {
  return RAW_IMAGE_EXT.has(extOf(name));
}

export interface RawDecodeOptions {
  useCameraWb?: boolean;
  /** 半尺寸解码:像素量 1/4,速度约 4 倍(用于缩略图兜底)。 */
  halfSize?: boolean;
}

export interface RawThumbnail {
  kind: 'jpeg' | 'rgb';
  data: Uint8Array;
  width: number;
  height: number;
}

export interface RawPixels {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface RawSession {
  thumbnail(): Promise<RawThumbnail | null>;
  pixels(): Promise<RawPixels>;
  close(): void;
}

interface LibrawInstance {
  open(bytes: Uint8Array, settings?: Record<string, unknown>): Promise<void>;
  metadata(fullOutput?: boolean): Promise<Record<string, unknown> | undefined>;
  imageData(): Promise<{ width: number; height: number; colors: number; bits: number; data: Uint8Array } | undefined>;
  thumbnailData(): Promise<{ data: Uint8Array; width: number; height: number; format: string } | undefined>;
  /** embind 析构:释放 wasm 堆上的 C++ LibRaw 对象(每次解码后必须调用)。 */
  delete(): void;
}

type LibrawFactory = (opts?: Record<string, unknown>) => Promise<{ LibRaw: new () => LibrawInstance }>;

// TS(module=CommonJS) 会把可静态分析的 import() 转译成 require(),
// 而 libraw.js 是 ESM(Electron 33 / Node 20 下 require(ESM) 不可用),
// 因此用运行时原生 dynamic import,绕开转译。
const dynamicImport = new Function('specifier', 'return import(specifier);') as
  (specifier: string) => Promise<{ default: LibrawFactory }>;

// 模块(wasm 编译产物)按线程缓存:每个 worker 线程只编译一次。
let modulePromise: Promise<{ LibRaw: new () => LibrawInstance }> | null = null;

/** 定位 libraw-wasm 的 dist 目录(兼容 electron-builder asarUnpack 布局)。 */
function librawDistDir(): string {
  // CJS 产物内 require 全局可用(由 tsc 转译保证)。
  const pkg = require.resolve('libraw-wasm/package.json') as string;
  let dir = path.dirname(pkg);
  if (dir.includes('app.asar') && !dir.includes('app.asar.unpacked')) {
    dir = dir.replace('app.asar', 'app.asar.unpacked');
  }
  return path.join(dir, 'dist');
}

async function loadLibraw(): Promise<{ LibRaw: new () => LibrawInstance }> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const distDir = librawDistDir();
      const wasmBinary = readFileSync(path.join(distDir, 'libraw.wasm'));
      const factoryUrl = pathToFileURL(path.join(distDir, 'libraw.js')).href;
      const mod = await dynamicImport(factoryUrl);
      return await mod.default({ wasmBinary, noInitialRun: true });
    })();
    // 加载失败(如打包布局变化)允许下次重试,而不是永久缓存 rejection。
    modulePromise.catch(() => {
      modulePromise = null;
    });
  }
  return modulePromise;
}

/** 打开一个 RAW 解码会话(当前线程内运行,解码期间会阻塞该线程)。 */
export async function openNodeRawSession(bytes: Uint8Array, opts?: RawDecodeOptions): Promise<RawSession> {
  const mod = await loadLibraw();
  const instance = new mod.LibRaw();
  try {
    await instance.open(bytes, {
      useCameraWb: opts?.useCameraWb ?? true,
      outputColor: 1, // sRGB
      outputBps: 8,
      halfSize: opts?.halfSize ?? false,
    });
  } catch (err) {
    instance.delete();
    throw err;
  }
  let closed = false;
  return {
    async thumbnail() {
      const thumb = await instance.thumbnailData();
      if (!thumb || thumb.data.byteLength === 0 || !thumb.width || !thumb.height) return null;
      if (thumb.format === 'jpeg') return { kind: 'jpeg', data: thumb.data, width: thumb.width, height: thumb.height };
      if (thumb.format === 'bitmap') return { kind: 'rgb', data: thumb.data, width: thumb.width, height: thumb.height };
      return null;
    },
    async pixels() {
      const img = await instance.imageData();
      if (!img || !img.width || !img.height) throw new Error('RAW 完整解码失败:无像素数据');
      return { data: img.data, width: img.width, height: img.height };
    },
    close() {
      if (closed) return;
      closed = true;
      instance.delete();
    },
  };
}
