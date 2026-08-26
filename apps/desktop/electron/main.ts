// Electron main process: native file system for import and album library.
import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol } from 'electron';
import { promises as fs, createWriteStream } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import archiver from 'archiver';
import { imageSize } from 'image-size';
import { logger, readLogTail, setLogLevel } from './logger';

// 应用 bundle 协议：生产构建渲染层以 kanitu-app:// 加载。file:// 下绝对路径会
// 404、且 type=module 脚本会被 CORS 拦截（白屏）；自定义 scheme 一步规避，
// 顺带为 SPA 路由/安全边界打底。必须在 app ready 之前注册。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kanitu-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif']);

let mainWindow: BrowserWindow | null = null;

interface FsFileMeta {
  relPath: string;
  size: number;
  mtime: number;
}

/** Walks a library subtree, counting images and collecting archive-relative metadata. */
async function collectLibraryFiles(dirPath: string, root: string, out: FsFileMeta[]): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      count += await collectLibraryFiles(full, root, out);
    } else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase().slice(1))) {
      const stat = await fs.stat(full);
      const rel = path.relative(root, full).split(path.sep).join('/');
      out.push({ relPath: rel, size: stat.size, mtime: stat.mtimeMs });
      count++;
    }
  }
  return count;
}

const indexBase = (relPath: string): string => (relPath.lastIndexOf('/') < 0 ? relPath : relPath.slice(relPath.lastIndexOf('/') + 1));
const indexParent = (relPath: string): string => {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
};
const indexExt = (relPath: string): string => {
  const i = relPath.lastIndexOf('.');
  return i < 0 ? '' : relPath.slice(i + 1).toLowerCase();
};

/** JSON index embedded into exported zips (mirrors fs-adapter/src/exportIndex.ts). */
function buildIndexJson(root: string, files: FsFileMeta[], exportedAt = Date.now()): string {
  const images = files
    .map((f) => ({ relPath: f.relPath, name: indexBase(f.relPath), size: f.size, mtime: f.mtime, ext: indexExt(f.relPath) }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  const folderSet = new Set<string>();
  for (const image of images) {
    let p = indexParent(image.relPath);
    while (p && !folderSet.has(p)) {
      folderSet.add(p);
      p = indexParent(p);
    }
  }
  const folders = [...folderSet]
    .sort((a, b) => a.localeCompare(b))
    .map((relPath) => ({
      relPath,
      name: indexBase(relPath),
      directImageCount: images.filter((x) => indexParent(x.relPath) === relPath).length,
      imageCount: images.filter((x) => x.relPath.startsWith(`${relPath}/`)).length,
      childCount: [...folderSet].filter((x) => indexParent(x) === relPath).length,
    }));
  return JSON.stringify({ version: 1, exportedAt, root, folders, images });
}

let libraryRoot = '';
let allowedSourceRoot: string | null = null;

interface DesktopFsEntry {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
  width?: number;
  height?: number;
}

/** 缩略图调试统计（供渲染端“设置→调试”展示）。 */
interface ThumbnailDebugStats {
  queuedByPriority: number[];
  inFlight: number;
  workers: number;
  thumbCacheEntries: number;
  thumbCacheBytes: number;
  diskFiles: number;
  debugEnabled: boolean;
}

/** 清除缓存的结果（供设置页反馈）。 */
interface ClearCacheResult {
  memoryEntries: number;
  memoryBytes: number;
  diskFiles: number;
  diskBytes: number;
}

function getLibraryRoot(): string {
  if (!libraryRoot) libraryRoot = path.join(app.getPath('userData'), 'albums');
  return libraryRoot;
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

function assertInsideLibrary(p: string): void {
  const root = path.resolve(getLibraryRoot());
  const target = path.resolve(p);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`路径不在图库内：${p}`);
  }
}

function assertSourceAllowed(p: string): void {
  const root = allowedSourceRoot;
  if (!root) throw new Error('当前没有已授权的源文件夹。');
  const target = path.resolve(p);
  const r = path.resolve(root);
  if (target === r || target.startsWith(r + path.sep)) return;
  throw new Error(`路径不在所选源文件夹内：${p}`);
}

async function readImageDimensions(filePath: string): Promise<{ width: number; height: number } | undefined> {
  if (!IMAGE_EXT.has(path.extname(filePath).toLowerCase().slice(1))) return undefined;
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = new Uint8Array(256 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const size = imageSize(buffer.subarray(0, bytesRead));
      if (size.width && size.height) return { width: size.width, height: size.height };
    } finally {
      await handle.close();
    }
  } catch {
    // fall through to nativeImage
  }
  const image = nativeImage.createFromPath(filePath);
  if (!image.isEmpty()) {
    const size = image.getSize();
    if (size.width > 0 && size.height > 0) return { width: size.width, height: size.height };
  }
  return undefined;
}

async function entryFor(fullPath: string, name?: string): Promise<DesktopFsEntry> {
  const stat = await fs.stat(fullPath);
  const isDir = stat.isDirectory();
  const dimensions = isDir ? undefined : await readImageDimensions(fullPath);
  return {
    id: fullPath,
    name: name ?? path.basename(fullPath),
    kind: isDir ? 'folder' : 'file',
    ...(isDir
      ? {}
      : { size: stat.size, mtime: stat.mtimeMs, width: dimensions?.width, height: dimensions?.height }),
  };
}

async function listEntries(dirPath: string): Promise<DesktopFsEntry[]> {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const entries: DesktopFsEntry[] = [];
  for (const dirent of dirents) {
    const full = path.join(dirPath, dirent.name);
    const stat = await fs.stat(full);
    const isDir = dirent.isDirectory();
    const dimensions = isDir ? undefined : await readImageDimensions(full);
    entries.push({
      id: full,
      name: dirent.name,
      kind: isDir ? 'folder' : 'file',
      ...(isDir
        ? {}
        : { size: stat.size, mtime: stat.mtimeMs, width: dimensions?.width, height: dimensions?.height }),
    });
  }
  return entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
  );
}

async function getOrCreateFolder(parentPath: string, name: string): Promise<DesktopFsEntry> {
  assertInsideLibrary(parentPath);
  const full = path.join(parentPath, name);
  await ensureDir(full);
  return entryFor(full, name);
}

async function createTopFolder(name: string): Promise<DesktopFsEntry> {
  const root = getLibraryRoot();
  await ensureDir(root);
  let actual = name;
  let i = 2;
  while (true) {
    const full = path.join(root, actual);
    try {
      await fs.mkdir(full);
      return await entryFor(full, actual);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        actual = `${name} (${i++})`;
      } else {
        throw err;
      }
    }
  }
}

/**
 * 通用字节级 LRU 缓存（仅按总字节数淘汰，无条数上限；Map 迭代序即插入序 =
 * 最近最少使用在前向淘汰）。用于缩略图：同一文件在同一会话内被反复请求时
 * 复用已生成的 JPEG 字节，避免每次都磁盘解码 + 缩放 + 重新编码。
 * 键由调用方拼入文件 mtime/size：文件被覆盖或移动后键自动变化，无需手动失效。
 */
function createByteLruCache(maxBytes: number): {
  get(key: string): Uint8Array | undefined;
  put(key: string, data: Uint8Array): void;
  clear(): void;
  stats: () => { entries: number; bytes: number; maxBytes: number };
} {
  const map = new Map<string, Uint8Array>();
  let bytes = 0;
  return {
    get(key: string): Uint8Array | undefined {
      const hit = map.get(key);
      if (hit) {
        // 删除后重插，把命中的条目挪到最新位置。
        map.delete(key);
        map.set(key, hit);
      }
      return hit;
    },
    put(key: string, data: Uint8Array): void {
      const existing = map.get(key);
      if (existing) {
        bytes -= existing.byteLength;
        map.delete(key);
      }
      map.set(key, data);
      bytes += data.byteLength;
      while (bytes > maxBytes && map.size > 0) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = map.get(oldestKey);
        map.delete(oldestKey);
        if (oldest) bytes -= oldest.byteLength;
      }
    },
    stats: () => ({ entries: map.size, bytes, maxBytes }),
    clear(): void {
      map.clear();
      bytes = 0;
    },
  };
}

/** 网格缩略图缓存（≤1024px JPEG）。 */
const thumbCache = createByteLruCache(512 * 1024 * 1024);
/** 单条内存缓存上限。普通缩略图几 KB~几十 KB；worker 生成的大 GIF 动画缩略图
 *  可能到数百 KB~数 MB，若按旧 512KB 上限则每次都要重读磁盘。提到 4MB，
 *  配合 512MB 总容量 LRU 兜底。 */
const MAX_MEM_CACHE_ENTRY_BYTES = 4 * 1024 * 1024;
/** 小于该字节数的 GIF 原样透传（动画完美且小）；更大的交给 worker 生成动画缩略图。 */
const GIF_PASSTHROUGH_LIMIT = 256 * 1024;

function putThumbCache(cacheKey: string, data: Uint8Array): void {
  if (data.byteLength <= MAX_MEM_CACHE_ENTRY_BYTES) thumbCache.put(cacheKey, data);
}

function thumbCacheKey(file: DesktopFsEntry, targetSize: number): string {
  return `${file.id}\u0000${file.mtime ?? 0}\u0000${file.size ?? 0}\u0000${targetSize}`;
}

// —— 缩略图磁盘持久化缓存 ——
// 内存缓存随应用重启清空；缩略图落盘到 userData/thumbcache（按文件
// mtime/size/尺寸/版本 做 SHA1 键），重启后直接读盘返回，免去重新解码。
const THUMB_DISK_VERSION = 1;
const THUMB_DISK_MAX_FILES = 20000;
const THUMB_DISK_MAX_BYTES = 1536 * 1024 * 1024; // 1.5GB

function thumbCacheDir(): string {
  return path.join(app.getPath('userData'), 'thumbcache');
}

function thumbDiskKey(file: DesktopFsEntry, targetSize: number): string {
  const raw = `${file.id}\u0000${file.mtime ?? 0}\u0000${file.size ?? 0}\u0000${targetSize}\u0000v${THUMB_DISK_VERSION}`;
  return createHash('sha1').update(raw).digest('hex');
}

async function readThumbFromDisk(hash: string): Promise<Uint8Array | null> {
  try {
    const buf = await fs.readFile(path.join(thumbCacheDir(), `${hash}.jpg`));
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function writeThumbToDisk(hash: string, data: Uint8Array): Promise<void> {
  try {
    const dir = thumbCacheDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${hash}.jpg`), data);
  } catch {
    // 落盘失败不影响功能（下次重新生成）。
  }
}

/** 启动时清理：文件数/总大小超限时按 mtime 删除最旧的。 */
async function pruneThumbCache(): Promise<void> {
  try {
    const dir = thumbCacheDir();
    const files: { name: string; size: number; mtimeMs: number }[] = [];
    for (const entry of await fs.readdir(dir)) {
      const st = await fs.stat(path.join(dir, entry));
      if (st.isFile()) files.push({ name: entry, size: st.size, mtimeMs: st.mtimeMs });
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    if (files.length <= THUMB_DISK_MAX_FILES && total <= THUMB_DISK_MAX_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs); // 最旧在前
    for (const f of files) {
      if (files.length <= THUMB_DISK_MAX_FILES && total <= THUMB_DISK_MAX_BYTES) break;
      await fs.rm(path.join(dir, f.name), { force: true });
      files.length--;
      total -= f.size;
    }
  } catch {
    // 清理失败忽略。
  }
}

// —— 缩略图 worker 池 ——
// nativeImage 只能在主进程使用，解码大图会长时间阻塞事件循环（UI/IPC 全被拖
// 慢）。缩略图生成交给 worker 线程（主路径 sharp/libvips），主进程只做缓存与
// 调度。队列为多级优先级：
//   0 可见 > 1 滚动方向预取 > 2 当前目录 > 3 子文件夹/封面 > 4 全库预热/无关，
// 高优先级永远先取，保证“屏幕里看到的”永远优先于后台预热；滚动方向预取只
// 落后可见请求一档，快速滚动时下一屏缩略图能抢在整目录预热洪峰前面生成。
const THUMB_WORKER_FORMATS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp']);
const THUMB_WORKER_COUNT = 4;
const THUMB_JOB_TIMEOUT_MS = 8000;
const THUMB_PRIORITIES = 5;

interface ThumbnailRequest {
  file: DesktopFsEntry;
  targetSize: number;
  priority: number;
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
}

/** 优先级桶数组：下标小者优先（0 可见 > 1 滚动方向 > 2 当前目录 > 3 子文件夹 > 4 全库）。 */
const thumbnailQueues: ThumbnailRequest[][] = Array.from({ length: THUMB_PRIORITIES }, () => []);
const workerPool: (Worker | null)[] = [];
const busyWorkers = new Set<Worker>();
const inFlightJobs = new Map<
  number,
  { worker: Worker; resolve: (data: Uint8Array) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
>();
let thumbnailRequestSeq = 0;
/** worker 处理失败/超时的文件路径黑名单：再次请求时直接走主进程回退，避免反复卡 worker。 */
const failedWorkerPaths = new Set<string>();
/** 调试开关：开启后主进程对每次缩略图请求的关键决策打日志（供“设置→调试”排查）。 */
let debugLogging = false;

function markWorkerFailed(filePath: string): void {
  failedWorkerPaths.add(filePath);
  if (failedWorkerPaths.size > 4000) failedWorkerPaths.clear(); // 简单防涨
}

function totalQueuedThumbnails(): number {
  let n = 0;
  for (const q of thumbnailQueues) n += q.length;
  return n;
}

/** 从最高优先级非空桶取下一个请求。 */
function takeNextThumbnail(): ThumbnailRequest | undefined {
  for (const q of thumbnailQueues) {
    if (q.length > 0) return q.shift();
  }
  return undefined;
}

function pumpThumbnailQueue(): void {
  for (let i = 0; i < THUMB_WORKER_COUNT; i++) {
    if (totalQueuedThumbnails() === 0) return;
    ensureThumbnailWorker(i);
    const worker = workerPool[i];
    if (!worker || busyWorkers.has(worker)) continue;
    const request = takeNextThumbnail();
    if (!request) return;
    const requestId = ++thumbnailRequestSeq;
    busyWorkers.add(worker);
    const timer = setTimeout(() => {
      const job = inFlightJobs.get(requestId);
      if (!job) return;
      inFlightJobs.delete(requestId);
      const idx = workerPool.indexOf(job.worker);
      if (idx >= 0) {
        // 解码卡死（巨型图等）：杀掉该 worker 释放槽位，避免堵住后续任务。
        terminateWorkerAt(idx);
      } else {
        busyWorkers.delete(job.worker);
      }
      markWorkerFailed(request.file.id);
      job.reject(new Error('缩略图生成超时'));
      pumpThumbnailQueue();
    }, THUMB_JOB_TIMEOUT_MS);
    inFlightJobs.set(requestId, { worker, resolve: request.resolve, reject: request.reject, timer });
    worker.postMessage({ requestId, filePath: request.file.id, targetSize: request.targetSize });
  }
}

function failWorkerJobs(worker: Worker, err: Error): void {
  for (const [id, job] of inFlightJobs) {
    if (job.worker === worker) {
      inFlightJobs.delete(id);
      clearTimeout(job.timer);
      job.reject(err);
    }
  }
  busyWorkers.delete(worker);
}

function ensureThumbnailWorker(index: number): void {
  if (workerPool[index]) return;
  const worker = new Worker(path.join(__dirname, 'thumbnailWorker.js'));
  workerPool[index] = worker;
  worker.on('message', (msg: { requestId: number; ok: boolean; data?: Uint8Array; error?: string }) => {
    const job = inFlightJobs.get(msg.requestId);
    if (!job) return; // 超时后迟到的响应
    inFlightJobs.delete(msg.requestId);
    clearTimeout(job.timer);
    busyWorkers.delete(job.worker);
    if (msg.ok && msg.data) job.resolve(msg.data);
    else job.reject(new Error(msg.error ?? '缩略图生成失败'));
    pumpThumbnailQueue();
  });
  worker.on('error', (err: unknown) => {
    failWorkerJobs(worker, err instanceof Error ? err : new Error(String(err)));
    terminateWorkerAt(index);
    pumpThumbnailQueue();
  });
  worker.on('exit', (code) => {
    if (code !== 0) failWorkerJobs(worker, new Error(`缩略图 worker 异常退出：${code}`));
    if (workerPool[index] === worker) terminateWorkerAt(index);
    pumpThumbnailQueue();
  });
}

function terminateWorkerAt(index: number): void {
  const worker = workerPool[index];
  workerPool[index] = null;
  if (worker) {
    busyWorkers.delete(worker);
    void worker.terminate().catch(() => {});
  }
}

function enqueueThumbnail(file: DesktopFsEntry, targetSize: number, priority: number): Promise<Uint8Array> {
  const cacheKey = thumbCacheKey(file, targetSize);
  const cached = thumbCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);
  return new Promise<Uint8Array>((resolve, reject) => {
    const level = Math.max(0, Math.min(THUMB_PRIORITIES - 1, priority));
    const request: ThumbnailRequest = { file, targetSize, priority: level, resolve, reject };
    // 按优先级入桶（0 可见 > 1 滚动方向预取 > 2 当前目录 > 3 子文件夹 > 4 全库预热），
    // 取任务时总是从高优先级桶开始，保证正在看的图不被预取洪峰拖慢。
    thumbnailQueues[level]!.push(request);
    for (let i = 0; i < THUMB_WORKER_COUNT; i++) ensureThumbnailWorker(i);
    pumpThumbnailQueue();
  });
}

/** 主进程 nativeImage 同步回退路径（webp/avif/未知格式或 worker 失败时）。 */
function generateThumbnailBytesNative(file: DesktopFsEntry, targetSize: number): Uint8Array {
  const image = nativeImage.createFromPath(file.id);
  if (image.isEmpty()) {
    throw new Error(`无法解码图片：${file.id}`);
  }
  const size = image.getSize();
  const scale = Math.min(1, targetSize / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const resized = image.resize({ width, height, quality: 'good' });
  return new Uint8Array(resized.toJPEG(80));
}

function registerIpc(): void {
  // Source picker (import only)
  ipcMain.handle('import:pickFolder', async (): Promise<DesktopFsEntry | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择要导入的文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selected = path.resolve(result.filePaths[0]!);
    allowedSourceRoot = selected;
    return entryFor(selected);
  });

  ipcMain.handle('import:releaseSource', async (): Promise<void> => {
    allowedSourceRoot = null;
  });

  ipcMain.handle('import:listChildren', async (_event, folder: DesktopFsEntry): Promise<DesktopFsEntry[]> => {
    assertSourceAllowed(folder.id);
    return listEntries(folder.id);
  });

  ipcMain.handle('import:readBlob', async (_event, file: DesktopFsEntry): Promise<Uint8Array> => {
    assertSourceAllowed(file.id);
    const buf = await fs.readFile(file.id);
    return new Uint8Array(buf);
  });

  // Album library (app-managed copy)
  ipcMain.handle('library:getRoot', async (): Promise<DesktopFsEntry> => {
    const root = getLibraryRoot();
    await ensureDir(root);
    return entryFor(root, '全部相册');
  });

  ipcMain.handle('library:ensureRoot', async (): Promise<DesktopFsEntry> => {
    const root = getLibraryRoot();
    await ensureDir(root);
    return entryFor(root, '全部相册');
  });

  ipcMain.handle('library:fingerprint', async (): Promise<string> => {
    const root = getLibraryRoot();
    await ensureDir(root);
    const stat = await fs.stat(root);
    return String(stat.mtimeMs);
  });

  ipcMain.handle('library:createFolder', async (_event, parent: DesktopFsEntry, name: string): Promise<DesktopFsEntry> => {
    return getOrCreateFolder(parent.id, name);
  });

  ipcMain.handle('library:createTopFolder', async (_event, name: string): Promise<DesktopFsEntry> => {
    return createTopFolder(name);
  });

  ipcMain.handle('library:writeBlob', async (_event, folder: DesktopFsEntry, name: string, data: Uint8Array): Promise<DesktopFsEntry> => {
    assertInsideLibrary(folder.id);
    await ensureDir(folder.id);
    const full = path.join(folder.id, name);
    await fs.writeFile(full, data);
    return entryFor(full, name);
  });

  ipcMain.handle('library:listChildren', async (_event, folder: DesktopFsEntry): Promise<DesktopFsEntry[]> => {
    assertInsideLibrary(folder.id);
    return listEntries(folder.id);
  });

  ipcMain.handle('library:readBlob', async (_event, file: DesktopFsEntry): Promise<Uint8Array> => {
    assertInsideLibrary(file.id);
    const ext = path.extname(file.id).toLowerCase();
    // Keep GIF animation by returning the original file; GIFs are usually small.
    if (ext === '.gif') {
      return await fs.readFile(file.id);
    }
    // For full-size viewing, decode natively and return a capped preview.
    // This avoids allocating a giant JS Buffer for very large photos.
    const image = nativeImage.createFromPath(file.id);
    if (image.isEmpty()) {
      throw new Error(`无法解码图片：${file.id}`);
    }
    const size = image.getSize();
    const maxDim = 2560;
    const scale = Math.min(1, maxDim / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const resized = image.resize({ width, height, quality: 'good' });
    return ext === '.png' ? resized.toPNG() : resized.toJPEG(85);
  });

  ipcMain.handle('library:readThumbnail', async (_event, file: DesktopFsEntry, maxSize: number, priority: number): Promise<Uint8Array> => {
    assertInsideLibrary(file.id);
    // 优先级：0 可见 > 1 当前目录 > 2 子文件夹 > 3 全库预热/无关。
    const level = Math.max(0, Math.min(THUMB_PRIORITIES - 1, priority || 0));
    const targetSize = Math.max(64, Math.min(maxSize || 512, 1024));
    const cacheKey = thumbCacheKey(file, targetSize);
    const cached = thumbCache.get(cacheKey);
    if (cached) return cached;

    // 磁盘持久化缓存：重启后/内存淘汰后直接读盘，免去重新解码。
    const diskKey = thumbDiskKey(file, targetSize);
    const diskHit = await readThumbFromDisk(diskKey);
    if (diskHit) {
      if (debugLogging) logger.debug('thumb', `磁盘命中 ${path.basename(file.id)} p=${level}`);
      thumbCache.put(cacheKey, diskHit);
      return diskHit;
    }
    if (debugLogging) {
      logger.debug('thumb', `缓存未命中，转生成 ${path.basename(file.id)} p=${level} size=${targetSize}`);
      logger.debug('thumb', `队列状态 ${JSON.stringify(thumbnailQueues.map((q) => q.length))}`);
    }

    const ext = path.extname(file.id).toLowerCase().slice(1);
    // GIF：小图原样透传（保持原动画，瞬时）；大图由 worker 生成“可动且小”的
    // 动画 GIF 缩略图（omggif 抽帧缩放重编码），不再让数 MB 大字节挤挤垮缓存。
    if (ext === 'gif') {
      const raw = new Uint8Array(await fs.readFile(file.id));
      if (raw.byteLength <= GIF_PASSTHROUGH_LIMIT) {
        putThumbCache(cacheKey, raw);
        void writeThumbToDisk(diskKey, raw);
        return raw;
      }
      try {
        const data = await enqueueThumbnail(file, targetSize, level);
        putThumbCache(cacheKey, data);
        void writeThumbToDisk(diskKey, data);
        return data;
      } catch (err) {
        if (level > 0) throw err;
        logger.warn('gif', `动画缩略图失败，回退原样：${path.basename(file.id)} (${String(err)})`);
        void writeThumbToDisk(diskKey, raw);
        return raw;
      }
    }

    // 优先走 worker 线程生成（不阻塞主进程，sharp 解码大图也快）。可见图片
    // 高优先级插队在前；黑名单文件直接跳过 worker。
    if (THUMB_WORKER_FORMATS.has(ext) && !failedWorkerPaths.has(file.id)) {
      try {
        const data = await enqueueThumbnail(file, targetSize, level);
        thumbCache.put(cacheKey, data);
        void writeThumbToDisk(diskKey, data);
        return data;
      } catch (err) {
        markWorkerFailed(file.id);
        logger.warn('thumb', `worker 失败，回退主进程解码：${path.basename(file.id)} (${String(err)})`);
        if (level > 0) throw err; // 预取不为失败文件触发主进程大图解码
      }
    }
    if (level > 0) throw new Error('低优先级跳过：worker 不可用，留给可见请求处理');
    // 让出事件循环：连续多个大图回退解码之间，窗口控制等 IPC 有机会执行。
    await new Promise<void>((r) => setImmediate(() => r()));
    const data = generateThumbnailBytesNative(file, targetSize);
    thumbCache.put(cacheKey, data);
    void writeThumbToDisk(diskKey, data);
    return data;
  });

  // 调试统计：主进程缩略图队列/缓存状态（供设置页“调试”面板）。
  ipcMain.handle('debug:thumbnailStats', async (): Promise<ThumbnailDebugStats> => {
    let diskFiles = 0;
    try {
      diskFiles = (await fs.readdir(thumbCacheDir())).length;
    } catch {
      diskFiles = 0;
    }
    const mem = thumbCache.stats();
    return {
      queuedByPriority: thumbnailQueues.map((q) => q.length),
      inFlight: inFlightJobs.size,
      workers: workerPool.filter((w): w is Worker => w !== null).length,
      thumbCacheEntries: mem.entries,
      thumbCacheBytes: mem.bytes,
      diskFiles,
      debugEnabled: debugLogging,
    };
  });

  ipcMain.handle('debug:setEnabled', (_event, enabled: boolean): void => {
    debugLogging = enabled === true;
    setLogLevel(debugLogging ? 'debug' : 'info'); // 调试开关同步控制主进程日志级别
  });

  // 日志等级选择（设置页“调试”）：校验后同步主进程日志级别与调试开关。
  ipcMain.handle('debug:setLevel', (_event, level: unknown): void => {
    const lvl = level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : 'info';
    debugLogging = lvl === 'debug';
    setLogLevel(lvl);
  });

  // 读取主进程日志文件尾部（UTF-8，含时间/等级；设置页“调试→主进程日志”）。
  ipcMain.handle('debug:readLogs', async (_event, maxLines?: number): Promise<string[]> => {
    return readLogTail(Math.max(10, Math.min(2000, maxLines ?? 300)));
  });

  // 清除缓存（供设置页“调试→清除缓存”测试用）：主进程内存 + 磁盘缩略图缓存。
  ipcMain.handle('cache:clear', async (): Promise<ClearCacheResult> => {
    const memStats = thumbCache.stats();
    thumbCache.clear();
    let diskFiles = 0;
    let diskBytes = 0;
    try {
      const dir = thumbCacheDir();
      const names = await fs.readdir(dir);
      for (const name of names) {
        const full = path.join(dir, name);
        try {
          const st = await fs.stat(full);
          diskBytes += st.size;
          diskFiles++;
          await fs.rm(full, { force: true });
        } catch {
          // 单个文件删除失败忽略
        }
      }
    } catch {
      // 目录不存在等情况忽略
    }
    return {
      memoryEntries: memStats.entries,
      memoryBytes: memStats.bytes,
      diskFiles,
      diskBytes,
    };
  });

  ipcMain.handle('library:move', async (_event, entry: DesktopFsEntry, toFolder: DesktopFsEntry, newName?: string): Promise<DesktopFsEntry> => {
    assertInsideLibrary(entry.id);
    assertInsideLibrary(toFolder.id);
    const target = path.join(toFolder.id, newName ?? path.basename(entry.id));
    await fs.rename(entry.id, target);
    return entryFor(target);
  });

  ipcMain.handle('library:remove', async (_event, entry: DesktopFsEntry): Promise<void> => {
    assertInsideLibrary(entry.id);
    await fs.rm(entry.id, { recursive: true, force: true });
  });

  // Export a folder (or the whole library) as a ZIP. Streams to a user-chosen path
  // so large libraries don't buffer entirely in memory. Uses STORE (no compression).
  ipcMain.handle('library:exportZip', async (event, targetRelPath: string) => {
    const libraryRoot = getLibraryRoot();
    await ensureDir(libraryRoot);
    const norm = String(targetRelPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const sourceDir = norm ? path.join(libraryRoot, ...norm.split('/')) : libraryRoot;
    assertInsideLibrary(sourceDir);
    const baseName = norm ? path.basename(norm) : '相册';

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出相册为 ZIP',
      defaultPath: path.join(app.getPath('desktop'), `${baseName}.zip`),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return { canceled: true };

    const files: FsFileMeta[] = [];
    const totalImages = await collectLibraryFiles(sourceDir, libraryRoot, files);
    const indexRoot = norm ? baseName : '';

    const output = createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 0 } });
    const done = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      output.on('error', reject);
      archive.on('error', reject);
    });

    archive.on('progress', (progress) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send('library:exportProgress', {
        done: Math.min(progress.entries.processed, totalImages),
        total: totalImages,
      });
    });

    archive.pipe(output);
    for (const file of files) {
      archive.file(path.join(libraryRoot, file.relPath), { name: file.relPath });
    }
    // Embed a portable index describing the exported folder tree + image metadata.
    archive.append(Buffer.from(buildIndexJson(indexRoot, files)), { name: 'index.json' });
    await archive.finalize();
    await done;

    return { canceled: false, outputPath: filePath, totalImages, exportedCount: totalImages };
  });
}

/** 生产构建渲染层产物根目录。
 *  源码运行：apps/web/dist；打包后：electron-builder extraResources 复制到
 *  resources/web/dist（见 apps/desktop/package.json 的 build.extraResources）。 */
function bundleRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web', 'dist');
  }
  return path.join(__dirname, '../../web/dist');
}

const BUNDLE_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * Registers the `kanitu-app://` protocol serving apps/web/dist build output.
 * 比 loadFile(file://) 稳：统一 scheme 规避绝对路径 404 与 file:// module CORS；
 * 只允许 dist 目录内文件（防目录穿越）。
 */
function registerBundleProtocol(): void {
  const root = bundleRoot();
  protocol.handle('kanitu-app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel) rel = 'index.html';
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      return new Response('禁止访问', { status: 403 });
    }
    try {
      const data = await fs.readFile(target);
      return new Response(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
        headers: { 'content-type': BUNDLE_MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream' },
      });
    } catch {
      return new Response('未找到', { status: 404 });
    }
  });
}

/**
 * Registers a guarded `kanitu-file://` protocol so the renderer can display the
 * ORIGINAL file: Chromium streams and decodes it in the renderer (no cap, no giant
 * IPC buffer). Only files inside the library are served.
 */
function registerViewerProtocol(): void {
  protocol.handle('kanitu-file', async (request) => {
    const filePath = new URL(request.url).searchParams.get('p');
    if (!filePath) return new Response('错误请求', { status: 400 });
    try {
      assertInsideLibrary(filePath);
    } catch {
      return new Response('禁止访问', { status: 403 });
    }

    try {
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('未找到', { status: 404 });
    }
  });
}

function registerWindowControlIpc(): void {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize-toggle', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle('window:close', () => mainWindow?.close());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    frame: false,
    title: '全能看图王',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  win.on('maximize', () => win.webContents.send('window:maximized-changed', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // 鼠标侧键（前进/后退）在 Chromium/Electron 里默认触发 WebContents 的历史
  // 导航（history.back/forward），会把本应交给应用的导航变成整页刷新/重载——
  // 侧键因此显得“响应慢”。这里阻止一切页内导航（本应用是单页，无内部跳转，
  // 程序化 loadURL 不受 will-navigate 影响），侧键导航由渲染进程自行处理。
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  // Avoid stale renderer bundles during development.
  if (process.env.VITE_DEV_SERVER_URL) {
    void win.webContents.session.clearCache();
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    const url = process.env.VITE_DEV_SERVER_URL;
    const cacheBust = `v=${Date.now()}`;
    void win.loadURL(url.includes('?') ? `${url}&${cacheBust}` : `${url}?${cacheBust}`);
  } else {
    // 生产构建：走 kanitu-app:// 协议（file:// 下绝对路径/模块脚本会白屏）。
    // 查询串仅用于破缓存，协议处理器按 pathname 服务文件。
    void win.loadURL(`kanitu-app://bundle/index.html?v=${Date.now()}`);
  }
}

void app.whenReady().then(() => {
  // Windows 控制台切 UTF-8 代码页（尽力而为），避免中文日志按 GBK 显示乱码。
  if (process.platform === 'win32') {
    try {
      execSync('chcp 65001>nul', { stdio: 'ignore' });
    } catch {
      // 非交互控制台下可能失败，忽略（日志文件与设置页面板不受影响）。
    }
  }
  registerIpc();
  registerViewerProtocol();
  registerBundleProtocol();
  registerWindowControlIpc();
  createWindow();
  // 后台清理缩略图磁盘缓存（超限时删除最旧）。
  void pruneThumbCache();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});