import type {
  FileRef,
  FolderRef,
  FsEntry,
  ImportSourcePicker,
  LibraryStore,
  NativeImportProgress,
  NativeImportResult,
  ZipExportResult,
} from './types';
import { isHeifImage, isRawImage } from '../../core/src/path';

export interface DesktopFsEntry {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
  width?: number;
  height?: number;
}

/** RAW 查看模式(与 apps/desktop/electron/rawDecoder.ts 的 RawViewMode 手工同步):
 * camera = 相机内嵌预览直出(机内渲染,保留机身创意外观的观感);
 * developed = LibRaw 完整解码(通用 RAW 显影)。Windows 照片等系统查看器的
 * 稳定画面同为 LibRaw 系显影,与 developed 一致;developed 亦是默认值。 */
export type DesktopRawViewMode = 'camera' | 'developed';

/** LibraryBrowser 维护的 localStorage 镜像键(与 UI 包共享字符串)。 */
const RAW_VIEW_MODE_STORAGE_KEY = 'kanitsu-raw-view-mode';

/** 渲染端当前 RAW 查看模式:同步读 localStorage 镜像即可,不必等 IPC
 * (主进程 settings.json 是持久事实源,渲染端只在设置变更时写它)。
 * 未设置回退 developed,与主进程默认一致。 */
function currentRawViewMode(): DesktopRawViewMode {
  try {
    return localStorage.getItem(RAW_VIEW_MODE_STORAGE_KEY) === 'camera' ? 'camera' : 'developed';
  } catch {
    return 'developed';
  }
}

/** 缩略图调试统计（主进程侧，供设置页“调试”面板展示）。 */
export interface ThumbnailDebugStats {
  queuedByPriority: number[];
  inFlight: number;
  workers: number;
  thumbCacheEntries: number;
  thumbCacheBytes: number;
  diskFiles: number;
  debugEnabled: boolean;
}

/** 清除缓存的结果。 */
export interface ClearCacheResult {
  memoryEntries: number;
  memoryBytes: number;
  diskFiles: number;
  diskBytes: number;
}

/** 图包保存位置（桌面端专有设置）。 */
export interface LibraryLocationInfo {
  path: string;
  isDefault: boolean;
  /** 首次运行引导是否已确认；false 时渲染端弹窗确认保存位置。 */
  confirmed: boolean;
  exists: boolean;
}

/** 更改图包保存位置的结果；error 为面向用户的中文说明。 */
export interface LibraryLocationChangeResult {
  canceled: boolean;
  path?: string;
  isDefault?: boolean;
  /** 是否把原位置的图库内容一并搬到了新位置。 */
  moved?: boolean;
  movedCount?: number;
  /** 搬移时因目标已有同名项而跳过的项数（这些文件仍留在原位置）。 */
  skippedCount?: number;
  error?: string;
}

export interface KanitsuDesktopBridge {
  platform: 'electron';
  version: string;
  getThumbnailDebugStats(): Promise<ThumbnailDebugStats>;
  setDebugEnabled(enabled: boolean): Promise<void>;
  setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): Promise<void>;
  readLogs(maxLines?: number): Promise<string[]>;
  clearCaches(): Promise<ClearCacheResult>;
  pickSourceFolder(): Promise<DesktopFsEntry | null>;
  listSourceChildren(folder: DesktopFsEntry): Promise<DesktopFsEntry[]>;
  readSourceBlob(file: DesktopFsEntry): Promise<Uint8Array>;
  importSourceTree(source: DesktopFsEntry, targetTopName: string, cancelToken?: string): Promise<NativeImportResult>;
  onImportProgress(callback: (progress: NativeImportProgress) => void): () => void;
  cancelTask(token: string): Promise<void>;
  releaseSource(): Promise<void>;
  /** 图包保存位置：首次运行引导与「设置 → 通用」共用。 */
  getLibraryLocation(): Promise<LibraryLocationInfo>;
  /** 确认当前保存位置（首次运行引导的「使用此位置」）。 */
  acknowledgeLibraryLocation(): Promise<LibraryLocationInfo>;
  /** 打开系统文件夹选择框并切换保存位置；取消时 canceled 为 true。 */
  chooseLibraryLocation(): Promise<LibraryLocationChangeResult>;
  /** 切回默认保存位置。 */
  resetLibraryLocation(): Promise<LibraryLocationChangeResult>;
  getLibraryRoot(): Promise<DesktopFsEntry>;
  ensureLibraryRoot(): Promise<DesktopFsEntry>;
  createLibraryFolder(parent: DesktopFsEntry, name: string): Promise<DesktopFsEntry>;
  createTopLibraryFolder(name: string): Promise<DesktopFsEntry>;
  writeLibraryBlob(folder: DesktopFsEntry, name: string, data: Uint8Array): Promise<DesktopFsEntry>;
  listLibraryChildren(folder: DesktopFsEntry): Promise<DesktopFsEntry[]>;
  readLibraryBlob(file: DesktopFsEntry): Promise<Uint8Array>;
  readLibraryThumbnail(file: DesktopFsEntry, maxSize: number, priority?: number): Promise<Uint8Array>;
  /** RAW 专用:确保解码派生图存在,返回其查看 URL(非 RAW 不应调用)。
   *  渲染端随调用传入当前查看模式(localStorage 镜像,同步可读,切换模式后
   *  立即生效,无 IPC 时序竞态);缺省时主进程用其持久值。 */
  ensureRawDerivative(file: DesktopFsEntry, viewMode?: DesktopRawViewMode): Promise<string>;
  /** 派生文件的完整解码是否已完成(developed 模式查看器的加载指示依据)。 */
  isRawDerivativeFullDone(derivPath: string): Promise<boolean>;
  /** RAW 查看模式:设置页变更时推送主进程持久化(settings.json)。 */
  setRawViewMode(mode: DesktopRawViewMode): Promise<void>;
  /** 回读主进程持久化的 RAW 查看模式(渲染端 localStorage 镜像的校准源)。 */
  getRawViewMode(): Promise<DesktopRawViewMode>;
  /** 派生文件所属查看模式的缓存;非 rawcache 下的文件返回 null。 */
  getRawDerivativeViewMode(derivPath: string): Promise<DesktopRawViewMode | null>;
  /** RAW 完整解码在后台覆盖预览级派生后推送(渲染端热替换当前图)。 */
  onRawDerivativeUpdated(callback: (info: { derivPath: string }) => void): () => void;
  moveLibraryEntry(entry: DesktopFsEntry, toFolder: DesktopFsEntry, newName?: string): Promise<DesktopFsEntry>;
  removeLibraryEntry(entry: DesktopFsEntry): Promise<void>;
  exportZip(targetRelPath: string): Promise<{
    canceled: boolean;
    outputPath?: string;
    totalImages?: number;
    exportedCount?: number;
  }>;
  getLibraryFingerprint(): Promise<string>;
  onExportProgress(callback: (progress: { done: number; total: number }) => void): () => void;
  minimizeWindow(): Promise<void>;
  maximizeWindowToggle(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximizedChanged(callback: (maximized: boolean) => void): () => void;
}

declare global {
  interface Window {
    kanitsuDesktop?: KanitsuDesktopBridge;
  }
}

function toFolderRef(entry: DesktopFsEntry): FolderRef {
  return { id: entry.id, name: entry.name, kind: 'folder' };
}

function toFileRef(entry: DesktopFsEntry): FileRef {
  return { id: entry.id, name: entry.name, kind: 'file', size: entry.size, mtime: entry.mtime, width: entry.width, height: entry.height };
}

function toEntry(ref: FolderRef | FileRef): DesktopFsEntry {
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

function requireBridge(): KanitsuDesktopBridge {
  const bridge = window.kanitsuDesktop;
  if (!bridge) throw new Error('kanitsuDesktop 桥未就绪，请在 Electron 环境中运行。');
  return bridge;
}

/** Electron source folder picker, used only while importing. */
export class ElectronImportSourcePicker implements ImportSourcePicker {
  async pickFolder(): Promise<FolderRef> {
    const entry = await requireBridge().pickSourceFolder();
    if (!entry) throw new Error('已取消选择文件夹。');
    return toFolderRef(entry);
  }

  async *listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void> {
    const entries = await requireBridge().listSourceChildren(toEntry(folder));
    for (const entry of entries) {
      yield entry.kind === 'folder' ? toFolderRef(entry) : toFileRef(entry);
    }
  }

  async readBlob(file: FileRef): Promise<Blob> {
    const data = await requireBridge().readSourceBlob(toEntry(file));
    return new Blob([data as BlobPart]);
  }

  async release(): Promise<void> {
    await requireBridge().releaseSource();
  }
}

/** Electron app-managed album library. */
export class ElectronLibraryStore implements LibraryStore {
  async getLibraryRoot(): Promise<FolderRef> {
    return toFolderRef(await requireBridge().getLibraryRoot());
  }

  async ensureLibraryRoot(): Promise<FolderRef> {
    return toFolderRef(await requireBridge().ensureLibraryRoot());
  }

  async createFolder(parent: FolderRef, name: string): Promise<FolderRef> {
    return toFolderRef(await requireBridge().createLibraryFolder(toEntry(parent), name));
  }

  async createTopFolder(name: string): Promise<FolderRef> {
    return toFolderRef(await requireBridge().createTopLibraryFolder(name));
  }

  async writeBlob(folder: FolderRef, name: string, blob: Blob): Promise<FileRef> {
    const data = new Uint8Array(await blob.arrayBuffer());
    return toFileRef(await requireBridge().writeLibraryBlob(toEntry(folder), name, data));
  }

  async *listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void> {
    const entries = await requireBridge().listLibraryChildren(toEntry(folder));
    for (const entry of entries) {
      yield entry.kind === 'folder' ? toFolderRef(entry) : toFileRef(entry);
    }
  }

  async readBlob(file: FileRef): Promise<Blob> {
    const data = await requireBridge().readLibraryBlob(toEntry(file));
    return new Blob([data as BlobPart]);
  }

  async importSourceTree(
    source: FolderRef,
    targetTopName: string,
    onProgress?: (p: NativeImportProgress) => void,
    cancelToken?: string,
  ): Promise<NativeImportResult> {
    const bridge = requireBridge();
    const off = bridge.onImportProgress((progress) => onProgress?.(progress));
    try {
      return await bridge.importSourceTree(toEntry(source), targetTopName, cancelToken);
    } finally {
      off();
    }
  }

  async readThumbnail(file: FileRef, maxSize = 512, options?: { priority?: number }): Promise<Blob> {
    const data = await requireBridge().readLibraryThumbnail(toEntry(file), maxSize, options?.priority ?? 0);
    return new Blob([data as BlobPart]);
  }

  async getLibraryFingerprint(): Promise<string> {
    return requireBridge().getLibraryFingerprint();
  }

  async getViewerUrl(file: FileRef): Promise<string> {
    // RAW/HEIF 无法被 Chromium <img> 解码:改用主进程解码的派生 JPEG
    // (userData/rawcache,kanitsu-file 协议同样流式服务)。查看模式随调用
    // 传入:camera=内嵌预览直出(毫秒级,即机内渲染);developed=先预览级、
    // 完整解码后台升级(经 onRawDerivativeUpdated 推送,渲染端热替换)。
    // 完整解码两种模式下都在后台执行,模式只决定显示哪份。HEIF 无独立
    // 内嵌预览,直接等待完整解码(秒级)。
    if (isRawImage(file.name) || isHeifImage(file.name)) {
      return requireBridge().ensureRawDerivative(toEntry(file), currentRawViewMode());
    }
    // 查看器始终显示原始分辨率原图（保留全部像素，便于 100% 查看）。
    // 主进程通过 kanitsu-file 协议直接服务原始文件，渲染进程用解码缓存池
    // 预解码相邻原图来缓解大图切换卡顿（见 LibraryBrowser 的 Viewer）。
    return `kanitsu-file://file/?p=${encodeURIComponent(file.id)}`;
  }

  onRawDerivativeUpdated(callback: (info: { derivPath: string }) => void): () => void {
    const bridge = requireBridge();
    return bridge.onRawDerivativeUpdated(({ derivPath }) => {
      // 只透传与当前查看模式匹配的升级:切换模式前的后台任务仍会完成并以
      // 同一路径推送事件,误热替换会让两种观感互相窜。查询属 IPC 异步,
      // 推送本身不频繁,开销可忽略。
      void bridge
        .getRawDerivativeViewMode(derivPath)
        .then((mode) => {
          if (mode !== null && mode === currentRawViewMode()) callback({ derivPath });
        })
        .catch(() => undefined);
    });
  }

  releaseViewerUrl(_url: string): void {
    // Protocol-backed URLs hold no client-side resource to release.
  }

  async move(entry: FsEntry, toFolder: FolderRef, newName?: string): Promise<FsEntry> {
    const moved = await requireBridge().moveLibraryEntry(toEntry(entry), toEntry(toFolder), newName);
    return moved.kind === 'folder' ? toFolderRef(moved) : toFileRef(moved);
  }

  async remove(entry: FsEntry): Promise<void> {
    await requireBridge().removeLibraryEntry(toEntry(entry));
  }

  async cancelTask(token: string): Promise<void> {
    await requireBridge().cancelTask(token);
  }

  async zipLibrary(targetRelPath: string, onProgress?: (done: number, total: number) => void): Promise<ZipExportResult> {
    const bridge = requireBridge();
    const off = bridge.onExportProgress((progress) => onProgress?.(progress.done, progress.total));
    try {
      onProgress?.(0, 0);
      const result = await bridge.exportZip(targetRelPath);
      if (result.canceled) throw new Error('导出已取消。');
      onProgress?.(result.exportedCount ?? 0, result.totalImages ?? 0);
      return {
        kind: 'file',
        outputPath: result.outputPath,
        totalImages: result.totalImages ?? 0,
        exportedCount: result.exportedCount ?? 0,
      };
    } finally {
      off();
    }
  }
}
