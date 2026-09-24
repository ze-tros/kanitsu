export interface FolderRef {
  id: string;
  name: string;
  kind: 'folder';
}

export interface FileRef {
  id: string;
  name: string;
  kind: 'file';
  size?: number;
  mtime?: number;
  width?: number;
  height?: number;
}

export type FsEntry = FolderRef | FileRef;
export type Unwatch = () => void;

export interface NativeImportSkippedFile {
  path: string;
  reason: 'no-extension' | 'unsupported-format';
}

export interface NativeImportProgress {
  scanned: number;
  copied: number;
  skipped: number;
  current?: string;
}

export interface NativeImportResult {
  /** 用户主动取消：已复制的文件保留，可直接在目标目录看到部分结果。 */
  canceled?: boolean;
  targetTopFolder: string;
  scannedFileCount: number;
  copiedImageCount: number;
  skippedCount: number;
  skippedFiles: NativeImportSkippedFile[];
  errors: string[];
}

/** Reads the user-selected source folder during import. */
export interface ImportSourcePicker {
  pickFolder(): Promise<FolderRef>;
  listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void>;
  readBlob(file: FileRef): Promise<Blob>;
  /** Releases any platform-side source-folder grant held by this picker. */
  release?(): Promise<void>;
}

/** Result of a zip export. `blob` is returned for in-app/download exports (web/memory);
 *  `outputPath` is returned when the platform wrote the zip natively (Electron save dialog). */
export interface ZipExportResult {
  kind: 'blob' | 'file';
  blob?: Blob;
  outputPath?: string;
  /** 用户主动取消：已写入的条目保留。 */
  canceled?: boolean;
  totalImages: number;
  exportedCount: number;
}

/** Manages the app-owned album library. */
export interface LibraryStore {
  getLibraryRoot(): Promise<FolderRef>;
  /** Lightweight fingerprint used to detect stale cached indexes. */
  getLibraryFingerprint(): Promise<string>;
  ensureLibraryRoot(): Promise<FolderRef>;
  createFolder(parent: FolderRef, name: string): Promise<FolderRef>;
  createTopFolder(name: string): Promise<FolderRef>;
  writeBlob(folder: FolderRef, name: string, blob: Blob): Promise<FileRef>;
  listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void>;
  readBlob(file: FileRef): Promise<Blob>;
  /**
   * 读取原始文件的字节区间 [offset, offset + length)，不解码也不重编码。
   * 元数据（EXIF）解析必须走这条：桌面端 readBlob 会经 nativeImage 重编码（EXIF 已剥离），
   * Android 端整读大图会撑爆 base64 字节桥。越过文件尾返回更短片段。
   */
  readSlice(file: FileRef, offset: number, length: number): Promise<Uint8Array>;
  /** Small thumbnail for grids/folder covers. Implementations should avoid loading the full image. */
  readThumbnail(file: FileRef, maxSize?: number, options?: { priority?: number }): Promise<Blob>;
  /** Original-resolution viewable URL for an `<img>` (streamed for Electron). */
  getViewerUrl(file: FileRef): Promise<string>;
  /** Releases resources held by a viewer URL (no-op for protocol-backed URLs). */
  releaseViewerUrl(url: string): void;
  /**
   * RAW 派生图后台升级推送(桌面端实现):首次查看先返回预览级派生,
   * 完整解码覆盖后触发回调,渲染端应重新调用 getViewerUrl 热替换当前图。
   * 未实现的平台(Memory;Android 的升级在 WebView 内完成)可省略。
   */
  onRawDerivativeUpdated?(callback: (info: { derivPath: string }) => void): () => void;
  move(entry: FsEntry, toFolder: FolderRef, newName?: string): Promise<FsEntry>;
  remove(entry: FsEntry): Promise<void>;
  /** Zips targetRelPath (empty = whole library) preserving directory structure. */
  zipLibrary(targetRelPath: string, onProgress?: (done: number, total: number) => void, cancelToken?: string): Promise<ZipExportResult>;
  /**
   * 可选：只打包图库中指定的图片（相对图库根的 relPath，保留目录结构），用于移动端
   * 多选导出。archiveName 为建议的文件名（不含 .zip）。未实现的平台 UI 不提供入口。
   */
  zipSelection?(relPaths: string[], archiveName: string, onProgress?: (done: number, total: number) => void, cancelToken?: string): Promise<ZipExportResult>;
  /**
   * Optional native fast path: copies the whole source tree into the library without
   * round-tripping file bytes through the JS bridge. Android SAF and Electron can both
   * implement this; platforms without it fall back to picker.readBlob + writeBlob.
   */
  importSourceTree?(source: FolderRef, targetTopName: string, onProgress?: (p: NativeImportProgress) => void, cancelToken?: string): Promise<NativeImportResult>;
  /** 取消指定 token 的原生任务（导入/导出）。未实现该能力的平台可省略。 */
  cancelTask?(token: string): Promise<void>;
}
