import type {
  FileRef,
  FolderRef,
  FsEntry,
  ImportSourcePicker,
  LibraryStore,
  NativeImportResult,
  NativeImportProgress,
  ZipExportResult,
} from './types';
import { isHeifImage, isRawImage } from '../../core/src/path';
import { decodeRawThumbnailJpeg } from '../../raw-decoder/src/index';

/** Capacitor native payload for a SAF/document or app-file entry. */
export interface AndroidFsEntry {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
  width?: number;
  height?: number;
}

export interface AndroidBinaryPayload {
  data: string; // base64
  mime?: string;
}

export interface AndroidImportResultPayload {
  canceled?: boolean;
  targetTopFolder: string;
  scannedFileCount: number;
  copiedImageCount: number;
  skippedCount: number;
  skippedFiles: { path: string; reason: 'no-extension' | 'unsupported-format' }[];
  errors: string[];
}

export interface AndroidThumbnailStats {
  queuedByPriority: number[];
  inFlight: number;
  diskFiles: number;
  diskBytes: number;
}

export interface AndroidExportResultPayload {
  canceled: boolean;
  outputPath?: string;
  totalImages?: number;
  exportedCount?: number;
}

/**
 * Raw Capacitor plugin surface. Binary values cross the JS bridge as base64 strings,
 * so this is intentionally separate from the wrapped KanitsuAndroidBridge below.
 */
interface KanitsuPluginNative {
  pickSourceFolder(): Promise<AndroidFsEntry | null>;
  listSourceChildren(opts: { folder: AndroidFsEntry }): Promise<{ entries: AndroidFsEntry[] }>;
  readSourceBlob(opts: { file: AndroidFsEntry }): Promise<AndroidBinaryPayload>;
  releaseSource(): Promise<void>;
  importSourceTree(opts: { source: AndroidFsEntry; targetTopName: string; cancelToken?: string }): Promise<AndroidImportResultPayload>;
  addListener(eventName: string, callback: (data: any) => void): { remove: () => void };
  getLibraryRoot(): Promise<AndroidFsEntry>;
  ensureLibraryRoot(): Promise<AndroidFsEntry>;
  createLibraryFolder(opts: { parent: AndroidFsEntry; name: string }): Promise<AndroidFsEntry>;
  createTopLibraryFolder(opts: { name: string }): Promise<AndroidFsEntry>;
  writeLibraryBlob(opts: { folder: AndroidFsEntry; name: string; data: string }): Promise<AndroidFsEntry>;
  listLibraryChildren(opts: { folder: AndroidFsEntry }): Promise<{ entries: AndroidFsEntry[] }>;
  readLibraryBlob(opts: { file: AndroidFsEntry }): Promise<AndroidBinaryPayload>;
  readLibrarySlice(opts: { file: AndroidFsEntry; offset: number; length: number }): Promise<AndroidBinaryPayload>;
  readLibraryThumbnail(opts: { file: AndroidFsEntry; maxSize: number; priority?: number; gifAnimated?: boolean }): Promise<AndroidBinaryPayload>;
  moveLibraryEntry(opts: { entry: AndroidFsEntry; toFolder: AndroidFsEntry; newName?: string }): Promise<AndroidFsEntry>;
  removeLibraryEntry(opts: { entry: AndroidFsEntry }): Promise<void>;
  getLibraryFingerprint(): Promise<{ fingerprint: string }>;
  getViewerUrl(opts: { file: AndroidFsEntry }): Promise<{ url: string }>;
  ensureViewerDerivative(opts: { file: AndroidFsEntry }): Promise<{ url: string }>;
  exportZip(opts: { targetRelPath: string; cancelToken?: string; includeRelPaths?: string[]; archiveName?: string }): Promise<AndroidExportResultPayload>;
  cancelTask(opts: { token: string }): Promise<void>;
  getThumbnailStats(): Promise<AndroidThumbnailStats>;
  clearCaches(): Promise<void>;
  setLogLevel(opts: { level: 'debug' | 'info' | 'warn' | 'error' }): Promise<void>;
  readLogs(opts: { maxLines?: number }): Promise<{ lines: string[] }>;
  setSystemTheme(opts: { dark: boolean; statusBarColor?: string; navBarColor?: string }): Promise<void>;
}

/** Wrapped bridge exposed as window.kanitsuAndroid to the shared UI/Core code. */
export interface KanitsuAndroidBridge {
  platform: 'android';
  version: string;
  pickSourceFolder(): Promise<AndroidFsEntry | null>;
  listSourceChildren(folder: AndroidFsEntry): Promise<AndroidFsEntry[]>;
  readSourceBlob(file: AndroidFsEntry): Promise<Uint8Array>;
  releaseSource(): Promise<void>;
  importSourceTree(source: AndroidFsEntry, targetTopName: string, cancelToken?: string): Promise<AndroidImportResultPayload>;
  onImportProgress(callback: (p: NativeImportProgress) => void): () => void;
  getLibraryRoot(): Promise<AndroidFsEntry>;
  ensureLibraryRoot(): Promise<AndroidFsEntry>;
  createLibraryFolder(parent: AndroidFsEntry, name: string): Promise<AndroidFsEntry>;
  createTopLibraryFolder(name: string): Promise<AndroidFsEntry>;
  writeLibraryBlob(folder: AndroidFsEntry, name: string, data: Uint8Array): Promise<AndroidFsEntry>;
  listLibraryChildren(folder: AndroidFsEntry): Promise<AndroidFsEntry[]>;
  readLibraryBlob(file: AndroidFsEntry): Promise<{ data: Uint8Array; mime?: string }>;
  readLibrarySlice(file: AndroidFsEntry, offset: number, length: number): Promise<Uint8Array>;
  readLibraryThumbnail(file: AndroidFsEntry, maxSize: number, priority?: number, gifAnimated?: boolean): Promise<{ data: Uint8Array; mime?: string }>;
  moveLibraryEntry(entry: AndroidFsEntry, toFolder: AndroidFsEntry, newName?: string): Promise<AndroidFsEntry>;
  removeLibraryEntry(entry: AndroidFsEntry): Promise<void>;
  getLibraryFingerprint(): Promise<string>;
  getViewerUrl(file: AndroidFsEntry): Promise<string>;
  ensureViewerDerivative(file: AndroidFsEntry): Promise<string>;
  exportZip(targetRelPath: string, cancelToken?: string, selection?: { includeRelPaths: string[]; archiveName: string }): Promise<AndroidExportResultPayload>;
  cancelTask(token: string): Promise<void>;
  onExportProgress(callback: (p: { done: number; total: number }) => void): () => void;
  getThumbnailStats(): Promise<AndroidThumbnailStats>;
  clearCaches(): Promise<void>;
  setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): Promise<void>;
  readLogs(maxLines?: number): Promise<string[]>;
  setSystemTheme(dark: boolean, statusBarColor?: string, navBarColor?: string): Promise<void>;
}

declare global {
  interface Window {
    kanitsuAndroid?: KanitsuAndroidBridge;
  }
}

/**
 * 分块 base64 解码：原生桥对整张图都返回单个 base64 串，若一次性 `atob` 成
 * 整段二进制串再逐字节拷出，峰值 ≈ 输入串(1.33×) + bin(1×) + 输出(1×)。
 * 按 4 字符对齐分块解码后，bin 只有块大小，峰值降到 输入串 + 输出。
 * 供测试复用。
 */
export function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob !== 'function') throw new Error('当前环境不支持 base64 解码。');
  // 输出长度按 padding 折算（Java 侧 NO_WRAP 编码不含空白；末尾 '=' 至多 2 个）。
  let pad = 0;
  for (let i = b64.length - 1; i >= 0 && b64[i] === '='; i--) pad++;
  const bytes = new Uint8Array(Math.max(0, (b64.length / 4) * 3 - pad));
  // 0x8000 是 4 的倍数：任意整块都能独立解码（padding 只出现在最后一块）。
  const CHUNK = 0x8000;
  let o = 0;
  for (let i = 0; i < b64.length; i += CHUNK) {
    const bin = atob(b64.substr(i, Math.min(CHUNK, b64.length - i)));
    for (let j = 0; j < bin.length; j++) bytes[o++] = bin.charCodeAt(j);
  }
  return bytes;
}

/**
 * base64 编码：按 3 字节对齐分块直接产出 base64 片段再拼接——中间不再构造
 * 等大的二进制串，`apply` 直接收 TypedArray（array-like）避免 `Array.from`
 * 的数字数组副本。当前 Android 导入走 importSourceTree 原生快路径，写路径
 * 无常规调用方；保留本函数与整块协议，供 readBlob 兜底与未来用途。
 * 供测试复用。
 */
export function bytesToB64(bytes: Uint8Array): string {
  // 3 字节对齐的分块（块间无 padding 混流），同时留出 apply 参数数量的安全余量。
  const CHUNK = 0x8000 - (0x8000 % 3);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, end) as unknown as number[])));
  }
  return parts.join('');
}

function toFolderRef(entry: AndroidFsEntry): FolderRef {
  return { id: entry.id, name: entry.name, kind: 'folder' };
}

function toFileRef(entry: AndroidFsEntry): FileRef {
  return {
    id: entry.id,
    name: entry.name,
    kind: 'file',
    size: entry.size,
    mtime: entry.mtime,
    width: entry.width,
    height: entry.height,
  };
}

function toEntry(ref: FolderRef | FileRef): AndroidFsEntry {
  return {
    id: ref.id,
    name: ref.name,
    kind: ref.kind,
    size: ref.kind === 'file' ? ref.size : undefined,
    mtime: ref.kind === 'file' ? ref.mtime : undefined,
    width: ref.kind === 'file' ? ref.width : undefined,
    height: ref.kind === 'file' ? ref.height : undefined,
  };
}

let bridgePromise: Promise<KanitsuAndroidBridge> | undefined;

// —— RAW 解码排队(Android WebView)——
// RAW 原文件经 capacitor 本地 HTTP 服务流式取回(fetch,不经 base64 桥),
// 在自管 Web Worker 内做 libraw 解码。解码占内存且是 CPU 密集,串行执行
// 以免快速滚动时并发解码打爆 WebView 堆。
let rawDecodeQueue: Promise<unknown> = Promise.resolve();

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const run = rawDecodeQueue.then(task, task);
  rawDecodeQueue = run.catch(() => undefined);
  return run;
}

/** 取回 RAW 原文件字节(通过 getViewerUrl 的本地 HTTP 流式服务)。 */
async function fetchRawBytes(store: { getViewerUrl(file: FileRef): Promise<string> }, file: FileRef): Promise<Uint8Array> {
  const url = await store.getViewerUrl(file);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`RAW 读取失败：HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

/**
 * Eagerly registers the Capacitor plugin and exposes window.kanitsuAndroid.
 * Call once at app startup on Android so platform detection and later calls are synchronous.
 */
export function initAndroidBridge(): Promise<KanitsuAndroidBridge> {
  return requireBridge();
}

/** 应用版本：构建时由 apps/web/vite.config.ts 从 apps/desktop/package.json 注入。 */
const APP_VERSION: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.KANITSU_VERSION ?? '';

function requireBridge(): Promise<KanitsuAndroidBridge> {
  if (window.kanitsuAndroid) return Promise.resolve(window.kanitsuAndroid);
  if (!bridgePromise) {
    bridgePromise = (async () => {
      const { registerPlugin } = await import('@capacitor/core');
      const p = registerPlugin<KanitsuPluginNative>('Kanitsu');
      const bridge: KanitsuAndroidBridge = {
        platform: 'android',
        // 构建时由 apps/web/vite.config.ts 从 apps/desktop/package.json 注入
        // （define import.meta.env.KANITSU_VERSION）；非 Vite 环境（类型检查/
        // 测试）为空，UI 侧据此省略版本号，不再显示写死的错误值。
        version: APP_VERSION,
        pickSourceFolder: () => p.pickSourceFolder(),
        listSourceChildren: async (folder) => (await p.listSourceChildren({ folder })).entries,
        readSourceBlob: async (file) => b64ToBytes((await p.readSourceBlob({ file })).data),
        releaseSource: () => p.releaseSource(),
        importSourceTree: (source, targetTopName, cancelToken) => p.importSourceTree({ source, targetTopName, cancelToken }),
        onImportProgress: (callback) => {
          const handle = p.addListener('importProgress', callback);
          let removed = false;
          return () => {
            if (!removed) {
              removed = true;
              handle.remove();
            }
          };
        },
        getLibraryRoot: () => p.getLibraryRoot(),
        ensureLibraryRoot: () => p.ensureLibraryRoot(),
        createLibraryFolder: (parent, name) => p.createLibraryFolder({ parent, name }),
        createTopLibraryFolder: (name) => p.createTopLibraryFolder({ name }),
        writeLibraryBlob: async (folder, name, data) => p.writeLibraryBlob({ folder, name, data: bytesToB64(data) }),
        listLibraryChildren: async (folder) => (await p.listLibraryChildren({ folder })).entries,
        readLibraryBlob: async (file) => {
          const payload = await p.readLibraryBlob({ file });
          return { data: b64ToBytes(payload.data), mime: payload.mime };
        },
        readLibrarySlice: async (file, offset, length) => {
          return b64ToBytes((await p.readLibrarySlice({ file, offset, length })).data);
        },
        readLibraryThumbnail: async (file, maxSize, priority, gifAnimated) => {
          const payload = await p.readLibraryThumbnail({ file, maxSize, priority: priority ?? 0, gifAnimated: gifAnimated !== false });
          return { data: b64ToBytes(payload.data), mime: payload.mime };
        },
        moveLibraryEntry: (entry, toFolder, newName) => p.moveLibraryEntry({ entry, toFolder, newName }),
        removeLibraryEntry: (entry) => p.removeLibraryEntry({ entry }),
        getLibraryFingerprint: async () => (await p.getLibraryFingerprint()).fingerprint,
        getViewerUrl: async (file) => (await p.getViewerUrl({ file })).url,
        ensureViewerDerivative: async (file) => (await p.ensureViewerDerivative({ file })).url,
        exportZip: (targetRelPath, cancelToken, selection) => p.exportZip({ targetRelPath, cancelToken, ...selection }),
        cancelTask: (token) => p.cancelTask({ token }),
        onExportProgress: (callback) => {
          const handle = p.addListener('exportProgress', callback);
          let removed = false;
          return () => {
            if (!removed) {
              removed = true;
              handle.remove();
            }
          };
        },
        getThumbnailStats: () => p.getThumbnailStats(),
        clearCaches: () => p.clearCaches(),
        setLogLevel: (level) => p.setLogLevel({ level }),
        readLogs: async (maxLines) => (await p.readLogs({ maxLines })).lines,
        setSystemTheme: (dark, statusBarColor, navBarColor) => p.setSystemTheme({ dark, statusBarColor, navBarColor }),
      };
      window.kanitsuAndroid = bridge;
      return bridge;
    })();
  }
  return bridgePromise;
}

/** Android SAF source folder picker, used only while importing. */
export class AndroidImportSourcePicker implements ImportSourcePicker {
  async pickFolder(): Promise<FolderRef> {
    const entry = await (await requireBridge()).pickSourceFolder();
    if (!entry) throw new Error('已取消选择文件夹。');
    return toFolderRef(entry);
  }

  async *listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void> {
    const entries = await (await requireBridge()).listSourceChildren(toEntry(folder));
    for (const entry of entries) {
      yield entry.kind === 'folder' ? toFolderRef(entry) : toFileRef(entry);
    }
  }

  async readBlob(file: FileRef): Promise<Blob> {
    const bytes = await (await requireBridge()).readSourceBlob(toEntry(file));
    return new Blob([bytes as BlobPart]);
  }

  async release(): Promise<void> {
    await (await requireBridge()).releaseSource();
  }
}

/** Android app-managed album library. */
export class AndroidLibraryStore implements LibraryStore {
  async getLibraryRoot(): Promise<FolderRef> {
    return toFolderRef(await (await requireBridge()).getLibraryRoot());
  }

  async ensureLibraryRoot(): Promise<FolderRef> {
    return toFolderRef(await (await requireBridge()).ensureLibraryRoot());
  }

  async createFolder(parent: FolderRef, name: string): Promise<FolderRef> {
    return toFolderRef(await (await requireBridge()).createLibraryFolder(toEntry(parent), name));
  }

  async createTopFolder(name: string): Promise<FolderRef> {
    return toFolderRef(await (await requireBridge()).createTopLibraryFolder(name));
  }

  async writeBlob(folder: FolderRef, name: string, blob: Blob): Promise<FileRef> {
    const data = new Uint8Array(await blob.arrayBuffer());
    return toFileRef(await (await requireBridge()).writeLibraryBlob(toEntry(folder), name, data));
  }

  async *listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void> {
    const entries = await (await requireBridge()).listLibraryChildren(toEntry(folder));
    for (const entry of entries) {
      yield entry.kind === 'folder' ? toFolderRef(entry) : toFileRef(entry);
    }
  }

  async readBlob(file: FileRef): Promise<Blob> {
    const { data, mime } = await (await requireBridge()).readLibraryBlob(toEntry(file));
    return new Blob([data as BlobPart], mime ? { type: mime } : undefined);
  }

  async readSlice(file: FileRef, offset: number, length: number): Promise<Uint8Array> {
    return (await requireBridge()).readLibrarySlice(toEntry(file), offset, length);
  }

  async readThumbnail(file: FileRef, maxSize = 512, options?: { priority?: number; gifAnimated?: boolean }): Promise<Blob> {
    // RAW 不进原生 ThumbnailService(BitmapFactory/ImageDecoder 解不了),
    // 在 WebView 内提取内嵌预览(或回退 halfSize 完整解码),结果仅进渲染端
    // 内存缓存(thumbnailCache 的 256MB LRU)。
    if (isRawImage(file.name)) {
      const blob = await runSerialized(async () => {
        const bytes = await fetchRawBytes(this, file);
        return await decodeRawThumbnailJpeg(bytes, { targetDim: Math.max(maxSize, 512) });
      });
      return blob;
    }
    const { data, mime } = await (await requireBridge()).readLibraryThumbnail(toEntry(file), maxSize, options?.priority ?? 0, options?.gifAnimated !== false);
    return new Blob([data as BlobPart], mime ? { type: mime } : undefined);
  }

  async getLibraryFingerprint(): Promise<string> {
    return (await requireBridge()).getLibraryFingerprint();
  }

  async getViewerUrl(file: FileRef): Promise<string> {
    // HEIF/HEIC:WebView(Chromium)解不了 HEVC,让原生解码成 JPEG 派生图
    // (落盘缓存)再流式给 <img>;缩略图不受影响,原生 ImageDecoder 直接可解。
    if (isHeifImage(file.name)) {
      return (await requireBridge()).ensureViewerDerivative(toEntry(file));
    }
    return (await requireBridge()).getViewerUrl(toEntry(file));
  }

  releaseViewerUrl(_url: string): void {
    // Served by Capacitor's local HTTP server; nothing to release client-side.
  }

  async move(entry: FsEntry, toFolder: FolderRef, newName?: string): Promise<FsEntry> {
    const moved = await (await requireBridge()).moveLibraryEntry(toEntry(entry), toEntry(toFolder), newName);
    return moved.kind === 'folder' ? toFolderRef(moved) : toFileRef(moved);
  }

  async remove(entry: FsEntry): Promise<void> {
    await (await requireBridge()).removeLibraryEntry(toEntry(entry));
  }

  async importSourceTree(source: FolderRef, targetTopName: string, onProgress?: (p: NativeImportProgress) => void, cancelToken?: string): Promise<NativeImportResult> {
    const bridge = await requireBridge();
    const off = bridge.onImportProgress((p) => onProgress?.(p));
    try {
      const result = await bridge.importSourceTree(toEntry(source), targetTopName, cancelToken);
      return {
        canceled: result.canceled,
        targetTopFolder: result.targetTopFolder,
        scannedFileCount: result.scannedFileCount,
        copiedImageCount: result.copiedImageCount,
        skippedCount: result.skippedCount,
        skippedFiles: result.skippedFiles,
        errors: result.errors,
      };
    } finally {
      off();
    }
  }

  async zipLibrary(targetRelPath: string, onProgress?: (done: number, total: number) => void, cancelToken?: string): Promise<ZipExportResult> {
    const bridge = await requireBridge();
    const off = bridge.onExportProgress((p) => onProgress?.(p.done, p.total));
    try {
      onProgress?.(0, 0);
      const result = await bridge.exportZip(targetRelPath, cancelToken);
      onProgress?.(result.exportedCount ?? 0, result.totalImages ?? 0);
      return {
        kind: 'file',
        outputPath: result.outputPath,
        canceled: result.canceled,
        totalImages: result.totalImages ?? 0,
        exportedCount: result.exportedCount ?? 0,
      };
    } finally {
      off();
    }
  }

  async zipSelection(relPaths: string[], archiveName: string, onProgress?: (done: number, total: number) => void, cancelToken?: string): Promise<ZipExportResult> {
    const bridge = await requireBridge();
    const off = bridge.onExportProgress((p) => onProgress?.(p.done, p.total));
    try {
      onProgress?.(0, relPaths.length);
      const result = await bridge.exportZip('', cancelToken, { includeRelPaths: relPaths, archiveName });
      onProgress?.(result.exportedCount ?? 0, result.totalImages ?? 0);
      return {
        kind: 'file',
        outputPath: result.outputPath,
        canceled: result.canceled,
        totalImages: result.totalImages ?? 0,
        exportedCount: result.exportedCount ?? 0,
      };
    } finally {
      off();
    }
  }

  async cancelTask(token: string): Promise<void> {
    await (await requireBridge()).cancelTask(token);
  }
}
