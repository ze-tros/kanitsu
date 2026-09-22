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
import { isRawImage } from '../../core/src/path';

export interface DesktopFsEntry {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
  width?: number;
  height?: number;
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
  getLibraryRoot(): Promise<DesktopFsEntry>;
  ensureLibraryRoot(): Promise<DesktopFsEntry>;
  createLibraryFolder(parent: DesktopFsEntry, name: string): Promise<DesktopFsEntry>;
  createTopLibraryFolder(name: string): Promise<DesktopFsEntry>;
  writeLibraryBlob(folder: DesktopFsEntry, name: string, data: Uint8Array): Promise<DesktopFsEntry>;
  listLibraryChildren(folder: DesktopFsEntry): Promise<DesktopFsEntry[]>;
  readLibraryBlob(file: DesktopFsEntry): Promise<Uint8Array>;
  readLibraryThumbnail(file: DesktopFsEntry, maxSize: number, priority?: number): Promise<Uint8Array>;
  /** RAW 专用:确保完整解码派生图存在,返回其查看 URL(非 RAW 不应调用)。 */
  ensureRawDerivative(file: DesktopFsEntry): Promise<string>;
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
    // RAW 无法被 Chromium <img> 解码:改用主进程完整解码的派生 JPEG
    // (userData/rawcache,kanitsu-file 协议同样流式服务)。首次打开需等待
    // 解码(秒级),生成结果落盘,后续打开即时返回。
    if (isRawImage(file.name)) {
      return requireBridge().ensureRawDerivative(toEntry(file));
    }
    // 查看器始终显示原始分辨率原图（保留全部像素，便于 100% 查看）。
    // 主进程通过 kanitsu-file 协议直接服务原始文件，渲染进程用解码缓存池
    // 预解码相邻原图来缓解大图切换卡顿（见 LibraryBrowser 的 Viewer）。
    return `kanitsu-file://file/?p=${encodeURIComponent(file.id)}`;
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
