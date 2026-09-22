// Electron main process: native file system for import and album library.
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, net, protocol } from 'electron';
import { promises as fs, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import archiver from 'archiver';
import { imageSize } from 'image-size';
import { logger, readLogTail, setLogLevel } from './logger';
import { HEIF_IMAGE_EXT, RAW_IMAGE_EXT, isHeifImage, isRawImage, librawDistDir, parseRawViewMode, type RawViewMode } from './rawDecoder';

// 应用 bundle 协议：生产构建渲染层以 kanitsu-app:// 加载。file:// 下绝对路径会
// 404、且 type=module 脚本会被 CORS 拦截（白屏）；自定义 scheme 一步规避，
// 顺带为 SPA 路由/安全边界打底。必须在 app ready 之前注册。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kanitsu-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// 普通图片 + 主流相机 RAW + HEIF/HEIC:后两类进入库、导入与 ZIP 导出(原样
// 拷贝/打包);解码不经 nativeImage/Chromium,RAW 走 libraw 专用管线
// (见 rawDecoder.ts),HEIF 走 libheif wasm 专用管线(见 heifDecoder.ts)。
const IMAGE_EXT = new Set(['jpg', 'jpe', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif', ...RAW_IMAGE_EXT, ...HEIF_IMAGE_EXT]);

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
    // 应用私有目录（缩略图缓存）不是图库内容，导出时跳过。
    if (isLibraryInternalName(entry.name)) continue;
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
const importCancelStates = new Map<string, { cancelled: boolean }>();

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

// —— 图包保存位置（桌面端可配置） ——
// 默认仍是 userData/albums，用户可在首次启动引导或「设置 → 通用」改到自选目录。
// 位置存在 userData/settings.json（与图库内容分离），选定的目录里写一个标记文件
// 用于识别「这个目录由 Kanitsu 管理」。之所以要标记：整理/删除只作用于图库内部，
// 若允许把用户自己的照片目录整体选成图库，那些原片就会被纳入整理与删除范围。
// v2:rawViewMode 字段加入。v1 文件里的 rawViewMode 只可能来自一个未发布
// 的中间构建(它把当时的默认值 camera 自动持久化了),因此 v2 起仅在文件
// 版本 ≥2 时读取该字段,老文件按新默认 developed 处理。
const SETTINGS_VERSION = 2;
const LIBRARY_MARKER_FILE = '.kanitsu-library.json';
/** 图库根目录下由本应用独占的私有目录（缩略图缓存等）。 */
const LIBRARY_CACHE_DIR = '.kanitsu-cache';

/** 目录项是否属于应用私有目录：图库扫描/导出/统计/搬移都必须跳过，
 *  否则缓存里的 JPEG 会被当成图库图片。 */
function isLibraryInternalName(name: string): boolean {
  return name === LIBRARY_CACHE_DIR || name === LIBRARY_MARKER_FILE;
}

/** 拒绝把应用私有名字用作图包/子目录名：会与标记文件、缓存目录撞名，撞上之后
 *  该目录会被当作私有目录从列表里隐藏，用户建了却看不到。 */
function assertNotLibraryInternalName(name: string): void {
  if (isLibraryInternalName(name.trim())) throw new Error(`“${name}”是应用保留名称，请换一个。`);
}

interface DesktopSettings {
  version: number;
  /** 用户选定的图包保存目录；空串表示使用默认位置。 */
  libraryRoot: string;
  /** 首次运行时的保存位置确认弹窗是否已完成。 */
  libraryLocationConfirmed: boolean;
  /** RAW 查看模式:'camera'(内嵌预览直出)| 'developed'(完整解码)。 */
  rawViewMode?: RawViewMode;
}

/** 图包保存位置信息（供渲染端展示与首次运行引导）。 */
interface LibraryLocationInfo {
  path: string;
  isDefault: boolean;
  confirmed: boolean;
  exists: boolean;
}

/** 更改图包保存位置的结果；错误文案由主进程给出，渲染端只负责讲给用户听。 */
interface LibraryLocationChangeResult {
  canceled: boolean;
  path?: string;
  isDefault?: boolean;
  /** 是否把原位置的图库内容一并搬到了新位置。 */
  moved?: boolean;
  movedCount?: number;
  /** 搬移时因目标已有同名项而跳过的项数。 */
  skippedCount?: number;
  error?: string;
}

let settingsCache: DesktopSettings | null = null;

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadDesktopSettings(): DesktopSettings {
  if (settingsCache) return settingsCache;
  settingsCache = { version: SETTINGS_VERSION, libraryRoot: '', libraryLocationConfirmed: false };
  try {
    const raw = JSON.parse(readFileSync(settingsFilePath(), 'utf8')) as Partial<DesktopSettings>;
    if (typeof raw.libraryRoot === 'string' && raw.libraryRoot) settingsCache.libraryRoot = raw.libraryRoot;
    settingsCache.libraryLocationConfirmed = raw.libraryLocationConfirmed === true;
    if ((raw.version ?? 0) >= 2) settingsCache.rawViewMode = parseRawViewMode(raw.rawViewMode);
  } catch {
    // 文件不存在或损坏：按「未设置」处理，用默认位置。
  }
  return settingsCache;
}

function saveDesktopSettings(patch: Partial<DesktopSettings>): void {
  const next: DesktopSettings = { ...loadDesktopSettings(), ...patch, version: SETTINGS_VERSION };
  settingsCache = next;
  try {
    writeFileSync(settingsFilePath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (error) {
    // 写盘失败不影响本次会话（内存值已生效），下次启动退回默认位置。
    logger.warn('library', `写入设置失败：${String(error)}`);
  }
}

function defaultLibraryRoot(): string {
  return path.join(app.getPath('userData'), 'albums');
}

function getLibraryRoot(): string {
  if (!libraryRoot) {
    const configured = loadDesktopSettings().libraryRoot;
    libraryRoot = configured ? path.resolve(configured) : defaultLibraryRoot();
  }
  return libraryRoot;
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Windows 上「目标文件正被别的进程打开」错误码。杀软实时扫描、资源管理器生成
 *  缩略图、云同步、以及解码器持有句柄都属于这一类，通常毫秒级就会自行释放。 */
const TRANSIENT_FILE_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

function isTransientFileError(error: unknown): boolean {
  return TRANSIENT_FILE_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '');
}

/**
 * 文件系统变更的退避重试（目前用于改名）。被占用的目标在 Windows 上会立刻失败
 * （EBUSY/EPERM），但占用方多半只持有毫秒级——等一拍重试即可成功，用户看到的就是
 * 「重命名偶发失败，再点一次又好了」。重试仍失败则抛出最后一次错误，由调用方按
 * 原有方式上报。删除走 fs.rm 自带的重试，见 removeWithRetry。
 */
async function withFileRetry<T>(op: () => Promise<T>, attempts = 8, delayMs = 80): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      if (attempt >= attempts - 1 || !isTransientFileError(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}

/**
 * 删除文件或整个目录。retryDelay/maxRetries 的退避重试只在 recursive 模式下生效，
 * 所以单文件删除也走 recursive（Node 在其中对每个条目单独重试，比整树重来更省）。
 * 总窗口约 2.9s，覆盖杀软扫描、资源管理器缩略图、解码线程等短暂占用。
 */
async function removeWithRetry(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
}

/**
 * 建立图库的应用私有骨架：标记文件 + 缓存目录。缓存目录在这里就建出来，是为了
 * 让「创建 .kanitsu-cache」这一步落在扫描取指纹之前——否则首次写缩略图会改动
 * 图库根目录的 mtime，让已保存的扫描索引指纹失效，下次启动白扫一遍。
 * 同一个根目录只跑一次（getRoot 与 fingerprint 在启动时是并发的）。
 */
function ensureLibraryScaffold(root: string): Promise<void> {
  const key = path.resolve(root);
  if (scaffoldFor !== key || !scaffoldRun) {
    scaffoldFor = key;
    scaffoldRun = buildLibraryScaffold(key);
  }
  return scaffoldRun;
}

let scaffoldFor: string | null = null;
let scaffoldRun: Promise<void> | null = null;

async function buildLibraryScaffold(root: string): Promise<void> {
  const marker = path.join(root, LIBRARY_MARKER_FILE);
  try {
    if (!(await pathExists(marker))) {
      const content = { app: 'kanitsu', version: SETTINGS_VERSION, createdAt: new Date().toISOString() };
      await fs.writeFile(marker, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
    }
  } catch (error) {
    logger.warn('library', `写入图库标记失败：${String(error)}`);
  }
  try {
    await fs.mkdir(path.join(root, LIBRARY_CACHE_DIR, 'thumbcache'), { recursive: true });
  } catch (error) {
    logger.warn('library', `创建缩略图缓存目录失败：${String(error)}`);
  }
}

async function hasLibraryMarker(root: string): Promise<boolean> {
  try {
    const text = (await fs.readFile(path.join(root, LIBRARY_MARKER_FILE))).toString('utf8');
    return (JSON.parse(text) as { app?: string }).app === 'kanitsu';
  } catch {
    return false;
  }
}

type LibraryDirKind = 'missing' | 'empty' | 'library' | 'foreign';

/** 判定候选目录能否直接作为图库：缺省/空目录可以，带标记的既有图库可以，
 *  其余非空目录拒绝（见上方标记文件的说明）。 */
async function inspectLibraryDir(target: string): Promise<{ kind: LibraryDirKind; entryCount: number }> {
  if (await hasLibraryMarker(target)) return { kind: 'library', entryCount: 0 };
  try {
    // 只算用户内容：留下的缓存目录（例如换位置后回退到这里）不该让目录显得「非空」。
    const visible = (await fs.readdir(target)).filter((name) => !isLibraryInternalName(name));
    return visible.length === 0 ? { kind: 'empty', entryCount: 0 } : { kind: 'foreign', entryCount: visible.length };
  } catch {
    return { kind: 'missing', entryCount: 0 };
  }
}

/** 拒绝磁盘根目录与系统目录：它们一旦成为图库，整理/删除会波及无关文件。 */
function validateLibraryLocation(target: string): string | null {
  const resolved = path.resolve(target);
  if (resolved === path.resolve(getLibraryRoot())) return null;
  if (path.parse(resolved).root === resolved) {
    return '不能把磁盘根目录作为图包保存位置，请先在其中新建一个专用文件夹。';
  }
  const systemKeys = ['home', 'desktop', 'documents', 'downloads', 'pictures', 'videos', 'music', 'appData', 'temp', 'userData'] as const;
  for (const key of systemKeys) {
    let dir = '';
    try {
      dir = app.getPath(key);
    } catch {
      continue; // 该平台没有这个路径
    }
    if (dir && path.resolve(dir) === resolved) {
      return '不能把系统目录本身作为图包保存位置，请改用其中的一个新文件夹。';
    }
  }
  const current = path.resolve(getLibraryRoot());
  if (resolved.startsWith(current + path.sep)) {
    return '新位置不能在当前图库内部，请选择其他文件夹。';
  }
  return null;
}

/** 统计图库内的图片数量：用来决定是否要询问「是否搬移现有图包」。 */
async function countLibraryImages(root: string): Promise<number> {
  let count = 0;
  try {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      // 缓存目录里的缩略图不是图库图片，不计入（也避免白白多走一遍 1.5GB）。
      if (isLibraryInternalName(entry.name)) continue;
      if (entry.isDirectory()) count += await countLibraryImages(path.join(root, entry.name));
      else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase().slice(1))) count++;
    }
  } catch {
    // 目录不可读按空处理
  }
  return count;
}

/** 把图库内容搬到新位置：优先 rename（同盘瞬时完成），跨盘回退为复制后删除；
 *  目标已有同名项时跳过（绝不覆盖），并把跳过数报给调用方。 */
async function moveLibraryContents(from: string, to: string): Promise<{ moved: number; skipped: number }> {
  let moved = 0;
  let skipped = 0;
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    // 标记文件与缓存目录不是图库内容：缓存按绝对路径做键，跟着搬过去也会全部
    // 失效重算，留在原处即可（原位置若重新启用，缓存仍然对得上）。
    if (isLibraryInternalName(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (await pathExists(dest)) {
      logger.warn('library', `目标位置已存在同名项，跳过：${dest}`);
      skipped++;
      continue;
    }
    try {
      // 被占用导致的 rename 失败重试即可恢复，不会被误判成跨盘搬移。
      await withFileRetry(() => fs.rename(src, dest));
    } catch {
      await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
      await removeWithRetry(src);
    }
    moved++;
  }
  return { moved, skipped };
}

/** 切换图包保存位置：校验目录 → 询问是否搬移现有图包 → 落盘设置。 */
async function applyLibraryLocation(target: string): Promise<LibraryLocationChangeResult> {
  const resolved = path.resolve(target);
  const invalid = validateLibraryLocation(resolved);
  if (invalid) return { canceled: false, error: invalid };

  const current = path.resolve(getLibraryRoot());
  const isDefault = resolved === path.resolve(defaultLibraryRoot());
  const persist = { libraryRoot: isDefault ? '' : resolved, libraryLocationConfirmed: true };

  if (resolved === current) {
    await ensureDir(resolved);
    await ensureLibraryScaffold(resolved);
    saveDesktopSettings(persist);
    return { canceled: false, path: resolved, isDefault };
  }

  // 默认位置是应用自己的目录，直接接管（升级上来的旧图库没有标记文件）。
  if (!isDefault) {
    const info = await inspectLibraryDir(resolved);
    if (info.kind === 'foreign') {
      return {
        canceled: false,
        error: `该文件夹里已有 ${info.entryCount} 项内容，且不是 Kanitsu 图库，不能选作保存位置。请选一个空文件夹或新建专用文件夹，避免把已有文件卷进图库的整理与删除。`,
      };
    }
  }

  let move = false;
  if ((await countLibraryImages(current)) > 0) {
    const answer = await dialog.showMessageBox({
      type: 'question',
      buttons: ['移动图包', '仅切换位置', '取消'],
      defaultId: 0,
      cancelId: 2,
      message: '要一并移动现有图包吗？',
      detail: `「移动图包」会把 ${current} 里的内容搬到新位置；「仅切换位置」保留在原处不删除，新位置从空图库开始。`,
    });
    if (answer.response === 2) return { canceled: true };
    move = answer.response === 0;
  }

  try {
    await ensureDir(resolved);
    await ensureLibraryScaffold(resolved);
    const moved = move ? await moveLibraryContents(current, resolved) : { moved: 0, skipped: 0 };
    // 内容搬空后撤掉旧标记：原目录恢复成普通文件夹，避免被误认为仍是图库。
    if (move) await fs.rm(path.join(current, LIBRARY_MARKER_FILE), { force: true });
    libraryRoot = resolved;
    saveDesktopSettings(persist);
    logger.info('library', `图包保存位置切换为 ${resolved}${move ? `（已搬移 ${moved.moved} 项，跳过 ${moved.skipped} 项）` : ''}`);
    return { canceled: false, path: resolved, isDefault, moved: move, movedCount: moved.moved, skippedCount: moved.skipped };
  } catch (error) {
    return { canceled: false, error: `切换保存位置失败：${String(error)}` };
  }
}

/** library:readSlice 单次读取上限：元数据解析只用得到头部几 KB。 */
const MAX_READ_SLICE = 16 * 1024 * 1024;

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

interface NativeImportProgress {
  scanned: number;
  copied: number;
  skipped: number;
  current?: string;
}

interface NativeImportResult {
  canceled: boolean;
  targetTopFolder: string;
  scannedFileCount: number;
  copiedImageCount: number;
  skippedCount: number;
  skippedFiles: Array<{ path: string; reason: 'no-extension' | 'unsupported-format' }>;
  errors: string[];
}

async function importSourceTreeNative(
  source: DesktopFsEntry,
  targetTopName: string,
  cancel: { cancelled: boolean },
  onProgress: (progress: NativeImportProgress) => void,
): Promise<NativeImportResult> {
  assertSourceAllowed(source.id);
  await ensureDir(getLibraryRoot());
  const targetTop = await createTopFolder(targetTopName);
  const state = {
    scanned: 0,
    copied: 0,
    skipped: 0,
    skippedFiles: [] as Array<{ path: string; reason: 'no-extension' | 'unsupported-format' }>,
    errors: [] as string[],
  };
  let lastProgressAt = 0;

  const emitProgress = (current?: string, force = false): void => {
    const now = Date.now();
    if (!force && lastProgressAt !== 0 && now - lastProgressAt < 100) return;
    lastProgressAt = now;
    onProgress({ scanned: state.scanned, copied: state.copied, skipped: state.skipped, current });
  };

  const walk = async (sourceDir: string, targetDir: string, relPath: string): Promise<void> => {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (cancel.cancelled) return;
      // 源目录若本身就是另一个 Kanitsu 图库，它的标记文件与缓存目录不是用户的
      // 图片：缓存里的缩略图都是 JPEG，照搬进来会被当成图库内容。
      if (isLibraryInternalName(entry.name)) continue;
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      const childRelPath = relPath ? path.join(relPath, entry.name).split(path.sep).join('/') : entry.name;

      if (entry.isDirectory()) {
        await ensureDir(targetPath);
        await walk(sourcePath, targetPath, childRelPath);
        continue;
      }

      state.scanned++;
      const ext = path.extname(entry.name).toLowerCase().slice(1);
      if (IMAGE_EXT.has(ext)) {
        try {
          // Desktop source and destination are local files. Keeping the copy in the
          // main process avoids transferring every image through renderer IPC.
          await fs.copyFile(sourcePath, targetPath);
          state.copied++;
        } catch (error) {
          state.errors.push(`${entry.name}: ${String(error)}`);
        }
      } else {
        state.skipped++;
        state.skippedFiles.push({ path: childRelPath, reason: ext ? 'unsupported-format' : 'no-extension' });
      }
      emitProgress(entry.name);
    }
  };

  await walk(source.id, targetTop.id, '');
  emitProgress(undefined, true);
  return {
    canceled: cancel.cancelled,
    targetTopFolder: targetTop.name,
    scannedFileCount: state.scanned,
    copiedImageCount: state.copied,
    skippedCount: state.skipped,
    skippedFiles: state.skippedFiles,
    errors: state.errors,
  };
}

async function readImageDimensions(filePath: string): Promise<{ width: number; height: number } | undefined> {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  if (!IMAGE_EXT.has(ext)) return undefined;
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
  // RAW 无法被 nativeImage 解码(TIFF 容器头尺寸探测已在上面的 image-size
  // 尝试中完成),直接返回无尺寸,避免无谓的整文件解码尝试。HEIF/HEIC 同理
  // (image-size 能读 ISOBMFF 容器头拿到尺寸;nativeImage 解不了 HEVC)。
  if (isRawImage(filePath) || isHeifImage(filePath)) return undefined;
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
/** 单条内存缓存上限。普通缩略图通常只有数十 KB，4MB 仅作异常输出兜底；
 *  总量仍由 512MB LRU 上限控制。 */
const MAX_MEM_CACHE_ENTRY_BYTES = 4 * 1024 * 1024;
// 缩略图输出策略版本。v2 将 GIF 网格预览改为静态首帧 JPEG，
// 避免大量卡片同时动画解码和合成。
const THUMB_CACHE_VERSION = 2;

function putThumbCache(cacheKey: string, data: Uint8Array): void {
  if (data.byteLength <= MAX_MEM_CACHE_ENTRY_BYTES) thumbCache.put(cacheKey, data);
}

function thumbCacheKey(file: DesktopFsEntry, targetSize: number): string {
  return `${file.id}\u0000${file.mtime ?? 0}\u0000${file.size ?? 0}\u0000${targetSize}\u0000v${THUMB_CACHE_VERSION}`;
}

// —— 缩略图磁盘持久化缓存 ——
// 内存缓存随应用重启清空；缩略图落盘到「图库根目录/.kanitsu-cache/thumbcache」
// （按文件 mtime/size/尺寸/版本 做 SHA1 键），重启后直接读盘返回，免去重新解码。
// 放在图库内而不是 userData：缓存描述的就是这批文件，跟图库同处一块盘，换位置
// 时不会让缓存在两个位置各留一份；用户想在设置里把整个图库挪到别的盘时，缓存
// 也一起搬过去。代价是这个目录必须被当作应用私有目录（见 isLibraryInternalName），
// 不能出现在图库列表、导出 ZIP 和搬移里。
const THUMB_DISK_MAX_FILES = 20000;
const THUMB_DISK_MAX_BYTES = 1536 * 1024 * 1024; // 1.5GB

function thumbCacheDir(): string {
  return path.join(getLibraryRoot(), LIBRARY_CACHE_DIR, 'thumbcache');
}

function thumbDiskKey(file: DesktopFsEntry, targetSize: number): string {
  const raw = `${file.id}\u0000${file.mtime ?? 0}\u0000${file.size ?? 0}\u0000${targetSize}\u0000v${THUMB_CACHE_VERSION}`;
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

/**
 * 旧版缩略图缓存固定放在 userData/thumbcache。缓存改到图库内之后，那个目录
 * 再也不会被读到，成了最多 1.5GB 的孤儿，启动时清一次。缩略图是可再生的派生
 * 数据（设置页「清除缓存」做的也是同一件事），不涉及用户文件。
 */
async function dropLegacyThumbCache(): Promise<void> {
  const legacy = path.join(app.getPath('userData'), 'thumbcache');
  if (path.resolve(legacy) === path.resolve(thumbCacheDir())) return;
  if (!(await pathExists(legacy))) return;
  try {
    await fs.rm(legacy, { recursive: true, force: true });
    logger.info('cache', `已清理旧位置的缩略图缓存：${legacy}`);
  } catch (error) {
    logger.warn('cache', `清理旧缩略图缓存失败：${String(error)}`);
  }
}

// —— 缩略图 worker 池 ——
// nativeImage 只能在主进程使用，解码大图会长时间阻塞事件循环（UI/IPC 全被拖
// 慢）。缩略图生成交给 worker 线程（主路径 sharp/libvips），主进程只做缓存与
// 调度。队列为多级优先级：
//   0 可见 > 1 滚动方向预取 > 2 当前目录 > 3 子文件夹/封面 > 4 全库预热/无关，
// 高优先级永远先取，保证“屏幕里看到的”永远优先于后台预热；滚动方向预取只
// 落后可见请求一档，快速滚动时下一屏缩略图能抢在整目录预热洪峰前面生成。
// sharp 直解格式 + RAW(libraw 内嵌预览提取,毫秒级;无预览时回退完整解码)
// + HEIF(libheif wasm 完整解码,秒级,同样放宽超时)。GIF 也走 worker 但走专属分支。
const THUMB_WORKER_FORMATS = new Set(['jpg', 'jpe', 'jpeg', 'png', 'webp', 'avif', 'bmp', ...RAW_IMAGE_EXT, ...HEIF_IMAGE_EXT]);
const THUMB_WORKER_COUNT = 4;
const THUMB_JOB_TIMEOUT_MS = 8000;
/** RAW/HEIF 任务超时:RAW 内嵌预览提取远低于此值,无预览回退完整解码时高像素
 *  机身可能需要数秒(45MP 约 2~5s);HEIF 为 wasm 完整解码(25MP 约 2~3s,
 *  48MP 更久)。放宽到 30s,超时仍杀 worker 释放槽位。 */
const THUMB_RAW_JOB_TIMEOUT_MS = 30000;
const THUMB_PRIORITIES = 5;

interface ThumbnailRequest {
  cacheKey: string;
  file: DesktopFsEntry;
  targetSize: number;
  priority: number;
  promise: Promise<Uint8Array>;
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
}

/** 优先级桶数组：下标小者优先（0 可见 > 1 滚动方向 > 2 当前目录 > 3 子文件夹 > 4 全库）。 */
const thumbnailQueues: ThumbnailRequest[][] = Array.from({ length: THUMB_PRIORITIES }, () => []);
/** 同一实际缓存键只保留一个排队中/处理中的 worker 请求，所有调用方共享其 Promise。 */
const pendingThumbnailRequests = new Map<string, ThumbnailRequest>();
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
    const isRawJob = isRawImage(request.file.id) || isHeifImage(request.file.id);
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
    }, isRawJob ? THUMB_RAW_JOB_TIMEOUT_MS : THUMB_JOB_TIMEOUT_MS);
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
  // librawDist:worker 内不做 require.resolve(asar 下 worker 模块解析不可靠),
  // 由主进程解析一次后下发;开发/打包两种布局都由 librawDistDir 归一。
  const worker = new Worker(path.join(__dirname, 'thumbnailWorker.js'), {
    workerData: { librawDist: librawDistDir() },
  });
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
  const level = Math.max(0, Math.min(THUMB_PRIORITIES - 1, priority));
  const pending = pendingThumbnailRequests.get(cacheKey);
  if (pending) {
    // 只迁移仍在桶中的请求；已经交给 worker 的任务直接共享，不能重复解码。
    if (level < pending.priority) {
      const currentQueue = thumbnailQueues[pending.priority]!;
      const queuedIndex = currentQueue.indexOf(pending);
      if (queuedIndex >= 0) {
        currentQueue.splice(queuedIndex, 1);
        pending.priority = level;
        thumbnailQueues[level]!.push(pending);
        pumpThumbnailQueue();
      }
    }
    return pending.promise;
  }

  let resolvePromise!: (data: Uint8Array) => void;
  let rejectPromise!: (err: Error) => void;
  const promise = new Promise<Uint8Array>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const request: ThumbnailRequest = {
    cacheKey,
    file,
    targetSize,
    priority: level,
    promise,
    resolve: (data) => {
      if (pendingThumbnailRequests.get(cacheKey) === request) pendingThumbnailRequests.delete(cacheKey);
      resolvePromise(data);
    },
    reject: (err) => {
      if (pendingThumbnailRequests.get(cacheKey) === request) pendingThumbnailRequests.delete(cacheKey);
      rejectPromise(err);
    },
  };
  pendingThumbnailRequests.set(cacheKey, request);
  // 按优先级入桶（0 可见 > 1 滚动方向预取 > 2 当前目录 > 3 子文件夹 > 4 全库预热），
  // 取任务时总是从高优先级桶开始，保证正在看的图不被预取洪峰拖慢。
  thumbnailQueues[level]!.push(request);
  for (let i = 0; i < THUMB_WORKER_COUNT; i++) ensureThumbnailWorker(i);
  pumpThumbnailQueue();
  return promise;
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

// —— RAW 查看派生服务 ——
// RAW 原文件无法被 Chromium <img> 解码，查看器改用 ensureRawDerivative 换取
// 解码后的 JPEG 派生图；派生文件落在 userData/rawcache，由
// kanitsu-file 协议同样以流式服务（见 registerViewerProtocol 的放行逻辑）。
// 按查看模式（RawViewMode，设置页「RAW 显示」）决定「显示哪份派生」，两份
// 缓存互不相通：
// - camera：内嵌预览直出（机内渲染结果，机身创意外观烧录在画面里）。
// - developed（默认）：先预览级派生消除黑屏，随后后台排队「完整解码」（秒级）
//   覆盖同一份文件——完成后 mtime 变化（即 URL 版本号）并推送
//   raw:derivativeUpdated 事件，渲染端热替换当前图。完整解码成功后写
//   .full 标记文件：缓存命中时据此判断是否需要补跑被中断的完整解码。
//   Windows 照片等系统查看器也是「先内嵌预览、后显影」的流程，其稳定
//   画面同为 LibRaw 系显影，与 developed 一致。
// 不论查看模式，完整解码始终在后台执行（另一模式的派生缓存同步补齐，
// 切换观感即刻可看）；显示层只跟随模式选择。
// HEIF 无机内渲染替代（内嵌即完整解码的产物），固定走 developed 路径。
// 派生缓存键含模式，切换设置不会命中另一模式的旧派生。
// 单 worker 串行：全解码秒级且内存大（45MP ≈ 135MB RGB），并发只会挤爆内存。
const RAW_DERIVATIVE_TIMEOUT_MS = 60000;
const RAW_PREVIEW_TIMEOUT_MS = 20000;
const RAW_DISK_MAX_FILES = 4096;
const RAW_DISK_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const RAW_DERIVATIVE_VERSION = 1;
/** 完整解码完成标记后缀（developed 模式缓存命中时校验）。 */
const RAW_FULL_MARKER_SUFFIX = '.full';

/** RAW 查看模式（设置页「RAW 显示」，渲染端经 raw:setViewMode 持久化到
 * settings.json）。默认 developed：与 Windows 照片等查看器的稳定渲染一致
 * （同为 LibRaw 系显影）。懒初始化:主进程早期模块加载时 settings.json 未必可读。 */
let rawViewModeCached: RawViewMode | null = null;
function currentRawViewMode(): RawViewMode {
  if (rawViewModeCached === null) {
    rawViewModeCached = parseRawViewMode(loadDesktopSettings().rawViewMode);
  }
  return rawViewModeCached;
}

function rawDerivativeDir(): string {
  return path.join(app.getPath('userData'), 'rawcache');
}

async function rawDerivativePathFor(filePath: string, mode: RawViewMode): Promise<string> {
  // 键取真实文件的 stat,不信任渲染进程传来的 mtime/size(可能过期)。
  let stamp = '0-0';
  try {
    const st = await fs.stat(filePath);
    stamp = `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    // stat 失败时仍生成一个键,后续生成会自然失败并报错给调用方。
  }
  const raw = `${filePath}\u0000${stamp}\u0000v${RAW_DERIVATIVE_VERSION}\u0000${mode}`;
  // 模式编码进文件名后缀(哈希反推不出模式),raw:getDerivativeViewMode 据此
  // 判定派生文件属于哪个查看模式的缓存。
  return path.join(rawDerivativeDir(), `${createHash('sha1').update(raw).digest('hex')}.${mode}.jpg`);
}

/** 完整解码完成标记(developed 模式用于区分「预览级缓存」与「完整解码缓存」)。 */
function rawFullMarkerPath(derivPath: string): string {
  return derivPath + RAW_FULL_MARKER_SUFFIX;
}

async function rawFullDone(derivPath: string): Promise<boolean> {
  try {
    return (await fs.stat(rawFullMarkerPath(derivPath))).isFile();
  } catch {
    return false;
  }
}

/** 命中返回缓存版本号(取 mtime 作 URL 版本,完整解码覆盖后自然变化)。 */
async function rawDerivativeHit(derivPath: string): Promise<number | null> {
  try {
    const st = await fs.stat(derivPath);
    if (st.isFile() && st.size > 0) return Math.floor(st.mtimeMs);
  } catch {
    // 未命中
  }
  return null;
}

function rawDerivativeUrl(derivPath: string, version: number): string {
  return `kanitsu-file://file/?p=${encodeURIComponent(derivPath)}&v=${version}`;
}

async function pruneRawDerivativeCache(): Promise<void> {
  try {
    const dir = rawDerivativeDir();
    const names = await fs.readdir(dir);
    const files: { name: string; size: number; mtimeMs: number }[] = [];
    for (const name of names) {
      const st = await fs.stat(path.join(dir, name));
      if (st.isFile()) files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    if (files.length <= RAW_DISK_MAX_FILES && total <= RAW_DISK_MAX_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (files.length <= RAW_DISK_MAX_FILES && total <= RAW_DISK_MAX_BYTES) break;
      await fs.rm(path.join(dir, f.name), { force: true });
      files.length--;
      total -= f.size;
    }
  } catch {
    // 清理失败忽略。
  }
}

interface RawDerivativeRequest {
  /** 源 RAW 文件路径(worker 任务输入)。 */
  sourcePath: string;
  /** 派生 JPEG 目标路径(磁盘缓存键)。 */
  derivPath: string;
  /** preview 插队(毫秒级);full 后台升级(秒级,完成后推送更新事件)。 */
  mode: 'preview' | 'full';
  resolve: (ok: boolean) => void;
  reject: (err: Error) => void;
}

let rawDerivativeWorker: Worker | null = null;
let rawDerivativeBusy = false;
let rawDerivativeSeq = 0;
const rawDerivativeQueue: RawDerivativeRequest[] = [];
const rawDerivativeInFlight = new Map<number, RawDerivativeRequest & { timer: NodeJS.Timeout }>();
/** 同一派生文件的并发请求共享同一个 Promise。 */
const rawDerivativePending = new Map<string, Promise<boolean>>();

function ensureRawDerivativeWorker(): Worker {
  if (rawDerivativeWorker) return rawDerivativeWorker;
  const worker = new Worker(path.join(__dirname, 'rawWorker.js'), {
    workerData: { librawDist: librawDistDir() },
  });
  rawDerivativeWorker = worker;
  worker.on('message', (msg: { requestId: number; ok: boolean; data?: Uint8Array; error?: string }) => {
    const job = rawDerivativeInFlight.get(msg.requestId);
    if (!job) return; // 超时后迟到的响应
    rawDerivativeInFlight.delete(msg.requestId);
    clearTimeout(job.timer);
    rawDerivativeBusy = false;
    if (msg.ok && msg.data) {
      void (async () => {
        try {
          await fs.mkdir(rawDerivativeDir(), { recursive: true });
          await fs.writeFile(job.derivPath, msg.data!);
          // 完整解码成功打标记:developed 模式缓存命中时据此免于重跑。
          // 预览级派生不打(它只是 developed 模式的中间产物)。
          if (job.mode === 'full') await fs.writeFile(rawFullMarkerPath(job.derivPath), '');
          job.resolve(true);
          if (job.mode === 'full') {
            // 完整解码覆盖预览级派生:通知渲染端热替换正在显示的同文件。
            mainWindow?.webContents.send('raw:derivativeUpdated', { derivPath: job.derivPath });
          }
          void pruneRawDerivativeCache();
        } catch (err) {
          job.reject(err instanceof Error ? err : new Error(String(err)));
        }
        pumpRawDerivativeQueue();
      })();
    } else {
      job.reject(new Error(msg.error ?? 'RAW 派生图生成失败'));
      pumpRawDerivativeQueue();
    }
  });
  worker.on('error', (err) => {
    failAllRawDerivatives(err instanceof Error ? err : new Error(String(err)));
  });
  worker.on('exit', (code) => {
    rawDerivativeWorker = null;
    rawDerivativeBusy = false;
    if (code !== 0) failAllRawDerivatives(new Error(`RAW 派生 worker 异常退出：${code}`));
    pumpRawDerivativeQueue();
  });
  return worker;
}

function failAllRawDerivatives(err: Error): void {
  for (const [, job] of rawDerivativeInFlight) {
    clearTimeout(job.timer);
    job.reject(err);
  }
  rawDerivativeInFlight.clear();
  rawDerivativeBusy = false;
}

function pumpRawDerivativeQueue(): void {
  if (rawDerivativeBusy || rawDerivativeQueue.length === 0) return;
  const request = rawDerivativeQueue.shift()!;
  const worker = ensureRawDerivativeWorker();
  const requestId = ++rawDerivativeSeq;
  rawDerivativeBusy = true;
  const timer = setTimeout(() => {
    const job = rawDerivativeInFlight.get(requestId);
    if (!job) return;
    rawDerivativeInFlight.delete(requestId);
    rawDerivativeBusy = false;
    // 解码卡死:终止 worker 释放线程,下次请求重建。
    void worker.terminate().catch(() => {});
    rawDerivativeWorker = null;
    job.reject(new Error('RAW 派生图生成超时'));
    pumpRawDerivativeQueue();
  }, request.mode === 'preview' ? RAW_PREVIEW_TIMEOUT_MS : RAW_DERIVATIVE_TIMEOUT_MS);
  rawDerivativeInFlight.set(requestId, { ...request, timer });
  worker.postMessage({ requestId, filePath: request.sourcePath, mode: request.mode });
}

function enqueueRawDerivativeJob(request: Omit<RawDerivativeRequest, 'resolve' | 'reject'>): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    // 预览任务插队:正在查看的图不能排在批量完整解码后面。
    if (request.mode === 'preview') rawDerivativeQueue.unshift({ ...request, resolve, reject });
    else rawDerivativeQueue.push({ ...request, resolve, reject });
    pumpRawDerivativeQueue();
  });
}

/** 已排队/进行中的后台完整解码(按派生路径去重,避免同一文件重复解码)。 */
const rawBackgroundFullInFlight = new Set<string>();

/** developed 模式的后台完整解码:排入派生队列尾(不插队),完成后覆盖同一份
 * 派生文件并推送 raw:derivativeUpdated 供渲染端热替换。失败不打扰查看
 * (预览级派生仍可看),下次 ensure 缓存未打标记时会再补。 */
function enqueueBackgroundFullDerivative(sourcePath: string, derivPath: string): void {
  if (rawBackgroundFullInFlight.has(derivPath)) return;
  rawBackgroundFullInFlight.add(derivPath);
  void enqueueRawDerivativeJob({ sourcePath, derivPath, mode: 'full' })
    .catch(() => undefined)
    .finally(() => rawBackgroundFullInFlight.delete(derivPath));
}

/** 后台补齐「非当前查看模式」的派生缓存(按路径去重):camera→developed 补
 * 完整解码(秒级,队列尾);developed→camera 补内嵌预览(毫秒级)。无论
 * 查看模式是什么,完整解码始终执行,只是显不显示由模式决定。 */
const rawAuxDerivativeInFlight = new Set<string>();
function enqueueAuxDerivative(sourcePath: string, auxMode: RawViewMode, auxPath: string): void {
  if (rawAuxDerivativeInFlight.has(auxPath)) return;
  rawAuxDerivativeInFlight.add(auxPath);
  void (async () => {
    if (auxMode === 'developed') {
      if (!(await rawFullDone(auxPath))) enqueueBackgroundFullDerivative(sourcePath, auxPath);
      return;
    }
    if ((await rawDerivativeHit(auxPath)) !== null) return;
    await enqueueRawDerivativeJob({ sourcePath, derivPath: auxPath, mode: 'preview' }).catch(() => undefined);
  })().finally(() => rawAuxDerivativeInFlight.delete(auxPath));
}

/**
 * 确保当前查看模式的派生图存在并返回其 kanitsu-file URL。
 * - camera:直通相机内嵌预览(机内渲染)。
 * - developed(默认):两段式,先预览级消除黑屏,完整解码后台覆盖升级。
 * 完整解码在两种模式下都始终执行(camera 模式也在后台为 developed 缓存
 * 解码,只是不显示、不热替换);模式只决定「显示哪份派生」。
 * HEIF 无机内渲染替代(内嵌缩略图质量差),固定走 developed 管线。
 * camera 模式预览失败抛错(无内嵌预览即无法查看);developed 模式自动回退
 * 完整解码(旧行为)。
 */
function ensureRawDerivative(file: DesktopFsEntry, mode: RawViewMode): Promise<string> {
  assertInsideLibrary(file.id);
  return (async () => {
    const isHeif = isHeifImage(file.id);
    const viewMode: RawViewMode = isHeif ? 'developed' : mode;
    const derivPath = await rawDerivativePathFor(file.id, viewMode);
    // 完整解码始终执行:后台补齐另一模式的派生缓存,切换观感即刻可看。
    // (camera 模式补的正是完整解码;developed 模式的完整解码由主流程负责,
    // 这里补的是直出预览。)排在缓存检查之前,cache 命中/未命中都调度。
    if (!isHeif) {
      const auxMode: RawViewMode = viewMode === 'camera' ? 'developed' : 'camera';
      enqueueAuxDerivative(file.id, auxMode, await rawDerivativePathFor(file.id, auxMode));
    }
    const cachedVersion = await rawDerivativeHit(derivPath);
    if (cachedVersion !== null) {
      // developed 命中的缓存可能是上次完整解码被中断的半成品(仅预览级):
      // 先返回缓存立即可看,同时补一个后台完整解码(有 .full 标记则免)。
      if (viewMode === 'developed' && !(await rawFullDone(derivPath))) {
        enqueueBackgroundFullDerivative(file.id, derivPath);
      }
      return rawDerivativeUrl(derivPath, cachedVersion);
    }
    const pending = rawDerivativePending.get(derivPath);
    if (pending) {
      // 并发请求共享;等待完成后以最新文件状态生成 URL。
      await pending.catch(() => undefined);
      const version = await rawDerivativeHit(derivPath);
      return rawDerivativeUrl(derivPath, version ?? Date.now());
    }
    const promise = (async () => {
      // 1) 预览级派生(插队):多数相机内嵌全尺寸 JPEG,即现即显。
      //    HEIF 无独立内嵌预览可提取(libheif 完整解码本身即大头),跳过直接完整解码。
      if (!isHeif) {
        const previewOk = await enqueueRawDerivativeJob({ sourcePath: file.id, derivPath, mode: 'preview' }).catch(() => false);
        if (previewOk) return true;
      }
      // 2) 无内嵌预览:回退完整解码(原行为,等待完成)。
      return await enqueueRawDerivativeJob({ sourcePath: file.id, derivPath, mode: 'full' });
    })();
    rawDerivativePending.set(derivPath, promise);
    promise.finally(() => rawDerivativePending.delete(derivPath)).catch(() => undefined);
    pumpRawDerivativeQueue();
    const ok = await promise;
    if (!ok) throw new Error('RAW 派生图生成失败');
    // camera 到此即完成;developed 若上一步等待的已是完整解码(预览级失败
    // 回退,worker 会打 .full 标记),否则补后台完整解码升级。
    if (viewMode === 'developed' && !(await rawFullDone(derivPath))) {
      enqueueBackgroundFullDerivative(file.id, derivPath);
    }
    const version = await rawDerivativeHit(derivPath);
    return rawDerivativeUrl(derivPath, version ?? Date.now());
  })();
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

  ipcMain.handle('import:tree', async (event, source: DesktopFsEntry, targetTopName: string, cancelToken?: string): Promise<NativeImportResult> => {
    const token = cancelToken ?? '';
    const cancel = { cancelled: false };
    importCancelStates.set(token, cancel);
    try {
      return await importSourceTreeNative(source, targetTopName, cancel, (progress) => event.sender.send('import:progress', progress));
    } finally {
      importCancelStates.delete(token);
    }
  });

  ipcMain.handle('import:cancel', async (_event, token: string): Promise<void> => {
    const state = importCancelStates.get(token);
    if (state) state.cancelled = true;
  });

  // —— 图包保存位置（仅桌面端：Web/Android 各自用应用目录，无此设置） ——
  ipcMain.handle('library:getLocation', async (): Promise<LibraryLocationInfo> => {
    const root = getLibraryRoot();
    return {
      path: root,
      isDefault: path.resolve(root) === path.resolve(defaultLibraryRoot()),
      confirmed: loadDesktopSettings().libraryLocationConfirmed,
      exists: await pathExists(root),
    };
  });

  ipcMain.handle('library:acknowledgeLocation', async (): Promise<LibraryLocationInfo> => {
    const root = getLibraryRoot();
    await ensureDir(root);
    await ensureLibraryScaffold(root);
    saveDesktopSettings({ libraryLocationConfirmed: true });
    return {
      path: root,
      isDefault: path.resolve(root) === path.resolve(defaultLibraryRoot()),
      confirmed: true,
      exists: true,
    };
  });

  ipcMain.handle('library:chooseLocation', async (): Promise<LibraryLocationChangeResult> => {
    if (importCancelStates.size > 0) {
      return { canceled: false, error: '有导入任务正在进行，请等它结束后再更改保存位置。' };
    }
    const result = await dialog.showOpenDialog({
      title: '选择图包保存位置',
      defaultPath: getLibraryRoot(),
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return applyLibraryLocation(result.filePaths[0]!);
  });

  ipcMain.handle('library:resetLocation', async (): Promise<LibraryLocationChangeResult> => {
    if (importCancelStates.size > 0) {
      return { canceled: false, error: '有导入任务正在进行，请等它结束后再更改保存位置。' };
    }
    return applyLibraryLocation(defaultLibraryRoot());
  });

  // Album library (app-managed copy)
  ipcMain.handle('library:getRoot', async (): Promise<DesktopFsEntry> => {
    const root = getLibraryRoot();
    await ensureDir(root);
    // 骨架必须先于扫描存在：否则首次写缩略图会改动根目录 mtime，取到的指纹
    // 与下次启动不一致，白扫一遍（见 ensureLibraryScaffold）。
    await ensureLibraryScaffold(root);
    return entryFor(root, '全部图包');
  });

  ipcMain.handle('library:ensureRoot', async (): Promise<DesktopFsEntry> => {
    const root = getLibraryRoot();
    await ensureDir(root);
    await ensureLibraryScaffold(root);
    return entryFor(root, '全部图包');
  });

  ipcMain.handle('library:fingerprint', async (): Promise<string> => {
    const root = getLibraryRoot();
    await ensureDir(root);
    // fingerprint 与 getRoot 在启动时并发调用，取指纹前同样要等骨架建好。
    await ensureLibraryScaffold(root);
    const stat = await fs.stat(root);
    return String(stat.mtimeMs);
  });

  ipcMain.handle('library:createFolder', async (_event, parent: DesktopFsEntry, name: string): Promise<DesktopFsEntry> => {
    assertNotLibraryInternalName(name);
    return getOrCreateFolder(parent.id, name);
  });

  ipcMain.handle('library:createTopFolder', async (_event, name: string): Promise<DesktopFsEntry> => {
    assertNotLibraryInternalName(name);
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
    // 应用私有目录（缩略图缓存）不出现在图库列表里：扫描基于这里的结果，
    // 一旦露出来，缓存里的 JPEG 就会被当成图库图片。
    const entries = await listEntries(folder.id);
    return entries.filter((entry) => !isLibraryInternalName(entry.name));
  });

  ipcMain.handle('library:readBlob', async (_event, file: DesktopFsEntry): Promise<Uint8Array> => {
    assertInsideLibrary(file.id);
    const ext = path.extname(file.id).toLowerCase();
    // Keep GIF animation by returning the original file; GIFs are usually small.
    if (ext === '.gif') {
      return await fs.readFile(file.id);
    }
    // HEIF/HEIC:nativeImage 解不了,复用查看派生管线换 libheif 解码的 JPEG
    // (≤8192,查看器 100% 查看同样走它)。调用方仅用于展示,尺寸上限无碍。
    if (isHeifImage(file.id)) {
      const derivPath = await rawDerivativePathFor(file.id, 'developed');
      if ((await rawDerivativeHit(derivPath)) === null) {
        await ensureRawDerivative(file, 'developed');
      }
      return await fs.readFile(derivPath);
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

  // 原始文件的字节区间：不解码、不重编码，供 EXIF 等元数据解析用。
  // readBlob 会经 nativeImage 重编码（EXIF 已剥离），元数据必须走这条。
  ipcMain.handle('library:readSlice', async (_event, file: DesktopFsEntry, offset: number, length: number): Promise<Uint8Array> => {
    assertInsideLibrary(file.id);
    const start = Math.max(0, Math.floor(offset) || 0);
    const size = Math.max(0, Math.min(Math.floor(length) || 0, MAX_READ_SLICE));
    if (size === 0) return new Uint8Array(0);
    const handle = await fs.open(file.id, 'r');
    try {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, start);
      // slice() 复制出独立缓冲区，避免整块 Buffer 随 IPC 一起被序列化。
      return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead).slice();
    } finally {
      await handle.close();
    }
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
    // GIF 在网格中只生成静态首帧 JPEG。同时解码数十个动画会占用渲染线程并
    // 放大 GC；打开查看器时仍读取原文件，不影响 GIF 播放。
    if (ext === 'gif') {
      try {
        const data = await enqueueThumbnail(file, targetSize, level);
        putThumbCache(cacheKey, data);
        void writeThumbToDisk(diskKey, data);
        return data;
      } catch (err) {
        if (level > 0) throw err;
        logger.warn('gif', `静态首帧生成失败，回退主进程解码：${path.basename(file.id)} (${String(err)})`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const data = generateThumbnailBytesNative(file, targetSize);
        putThumbCache(cacheKey, data);
        void writeThumbToDisk(diskKey, data);
        return data;
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

  // 清除缓存（供设置页“调试→清除缓存”测试用）：主进程内存 + 磁盘缩略图/RAW 派生缓存。
  ipcMain.handle('cache:clear', async (): Promise<ClearCacheResult> => {
    const memStats = thumbCache.stats();
    thumbCache.clear();
    let diskFiles = 0;
    let diskBytes = 0;
    const clearDir = async (dir: string): Promise<void> => {
      try {
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
    };
    await clearDir(thumbCacheDir());
    await clearDir(rawDerivativeDir());
    return {
      memoryEntries: memStats.entries,
      memoryBytes: memStats.bytes,
      diskFiles,
      diskBytes,
    };
  });

  // RAW 查看派生图:按查看模式(camera/developed)确保派生 JPEG 存在并返回其
  // URL(RAW 无法被 Chromium 直接解码,查看器对 RAW 文件改走此路径,见
  // ElectronLibraryStore)。模式由渲染端随调用传入(localStorage 镜像,同步
  // 可读):查看器切换模式后立即重取 URL,若这里读主进程持久值会有 IPC 时序
  // 竞态;缺省时回退主进程持久值。
  ipcMain.handle('raw:ensureDerivative', async (_event, file: DesktopFsEntry, mode?: unknown): Promise<string> => {
    return ensureRawDerivative(file, mode == null ? currentRawViewMode() : parseRawViewMode(mode));
  });

  // 派生文件的完整解码是否已完成(developed 模式渲染端据此显示/撤下加载指示;
  // camera 模式恒 false 但渲染端不会查询)。仅接受 rawcache 下的派生路径。
  ipcMain.handle('raw:isFullDone', async (_event, derivPath: string): Promise<boolean> => {
    if (path.dirname(derivPath) !== rawDerivativeDir()) return false;
    return await rawFullDone(derivPath);
  });

  // RAW 查看模式:渲染端在设置变更时推送(主进程侧持久化到 settings.json,
  // 重启后生效;LibraryBrowser 另有一份 localStorage 镜像做首帧前的取值)。
  ipcMain.handle('raw:setViewMode', async (_event, mode: unknown): Promise<void> => {
    rawViewModeCached = parseRawViewMode(mode);
    saveDesktopSettings({ rawViewMode: rawViewModeCached });
  });

  ipcMain.handle('raw:getViewMode', async (): Promise<RawViewMode> => {
    return currentRawViewMode();
  });

  // 查看器热替换前核对:派生文件按模式分缓存,只有与当前查看模式匹配的升级
  // 才应触发 URL 重取(否则 camera 模式会被遗留的 developed 后台任务误触发,
  // 反之亦然)。派生文件固定在 rawcache 根下,用目录+文件名校验而非图库守卫
  // (rawcache 在图库外,assertInsideLibrary 不适用)。
  ipcMain.handle('raw:getDerivativeViewMode', async (_event, derivPath: string): Promise<RawViewMode | null> => {
    if (path.dirname(derivPath) !== rawDerivativeDir()) return null;
    const name = path.basename(derivPath);
    if (name.endsWith('.camera.jpg')) return 'camera';
    if (name.endsWith('.developed.jpg')) return 'developed';
    return null;
  });

  ipcMain.handle('library:move', async (_event, entry: DesktopFsEntry, toFolder: DesktopFsEntry, newName?: string): Promise<DesktopFsEntry> => {
    assertInsideLibrary(entry.id);
    assertInsideLibrary(toFolder.id);
    if (newName) assertNotLibraryInternalName(newName);
    const target = path.join(toFolder.id, newName ?? path.basename(entry.id));
    await withFileRetry(() => fs.rename(entry.id, target));
    return entryFor(target);
  });

  ipcMain.handle('library:remove', async (_event, entry: DesktopFsEntry): Promise<void> => {
    assertInsideLibrary(entry.id);
    await removeWithRetry(entry.id);
  });

  // Export a folder (or the whole library) as a ZIP. Streams to a user-chosen path
  // so large libraries don't buffer entirely in memory. Uses STORE (no compression).
  ipcMain.handle('library:exportZip', async (event, targetRelPath: string) => {
    const libraryRoot = getLibraryRoot();
    await ensureDir(libraryRoot);
    const norm = String(targetRelPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const sourceDir = norm ? path.join(libraryRoot, ...norm.split('/')) : libraryRoot;
    assertInsideLibrary(sourceDir);
    const baseName = norm ? path.basename(norm) : '图包';

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出图包为 ZIP',
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

/** Returns the application icon both in development and in packaged builds. */
function applicationIconPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'kanitsu-icon.png');
  return path.resolve(__dirname, '../../..', 'assets', 'kanitsu-icon.png');
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
  '.jpe': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * Registers the `kanitsu-app://` protocol serving apps/web/dist build output.
 * 比 loadFile(file://) 稳：统一 scheme 规避绝对路径 404 与 file:// module CORS；
 * 只允许 dist 目录内文件（防目录穿越）。
 */
function registerBundleProtocol(): void {
  const root = bundleRoot();
  protocol.handle('kanitsu-app', async (request) => {
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
 * Registers a guarded `kanitsu-file://` protocol so the renderer can display the
 * ORIGINAL file: Chromium streams and decodes it in the renderer (no cap, no giant
 * IPC buffer). Only files inside the library are served, plus RAW 查看派生图
 * (userData/rawcache,见 ensureRawDerivative)。
 */
function registerViewerProtocol(): void {
  protocol.handle('kanitsu-file', async (request) => {
    const filePath = new URL(request.url).searchParams.get('p');
    if (!filePath) return new Response('错误请求', { status: 400 });
    try {
      assertInsideLibrary(filePath);
    } catch {
      // 图库外的唯一放行对象:RAW 派生缓存目录(路径由主进程生成,
      // 渲染进程无法伪造目录穿越,这里仍做前缀校验)。
      const dir = path.resolve(rawDerivativeDir());
      const target = path.resolve(filePath);
      if (!(target.startsWith(dir + path.sep))) {
        return new Response('禁止访问', { status: 403 });
      }
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

// —— 启动窗口底色 ——

// 渲染进程完成首帧前，窗口底色直接用应用的主题底色（body 的
// --color-base-100，见 styles/theme.css），而不是 Chromium 默认白色。
// 具体取值不能依赖 nativeTheme：应用的界面主题存在渲染进程 localStorage
// 里，主进程读不到，"系统浅色 + 应用暗色"组合下按系统预设会闪白。
// 最终值由 preload 在页面脚本运行前读取 localStorage 解析后经
// theme:bootstrap 同步过来（窗口此时尚未显示），见 preload.ts。
const THEME_BACKGROUNDS: Record<'dark' | 'light', string> = {
  dark: '#18181a',
  light: '#fbfcfd',
};

function registerThemeBootstrap(): void {
  ipcMain.on('theme:bootstrap', (event, theme: string) => {
    if (theme !== 'dark' && theme !== 'light') return;
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setBackgroundColor(THEME_BACKGROUNDS[theme]);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    frame: false,
    title: 'Kanitsu',
    icon: applicationIconPath(),
    // 窗口显示前的兜底底色（preload 同步的精确值会在此之前覆盖它）。
    backgroundColor: nativeTheme.shouldUseDarkColors ? THEME_BACKGROUNDS.dark : THEME_BACKGROUNDS.light,
    // 首帧就绪后再显示窗口：避免"先显示未绘制的窗口，再跳变成应用"的过程。
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  win.once('ready-to-show', () => win.show());
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
    // 生产构建：走 kanitsu-app:// 协议（file:// 下绝对路径/模块脚本会白屏）。
    // 查询串仅用于破缓存，协议处理器按 pathname 服务文件。
    void win.loadURL(`kanitsu-app://bundle/index.html?v=${Date.now()}`);
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
  registerThemeBootstrap();
  createWindow();
  // 后台清理缩略图磁盘缓存（超限时删除最旧），并回收旧版本留在 userData 的缓存。
  void pruneThumbCache();
  void dropLegacyThumbCache();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
