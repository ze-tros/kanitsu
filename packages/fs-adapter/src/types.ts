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
  /** Small thumbnail for grids/folder covers. Implementations should avoid loading the full image. */
  readThumbnail(file: FileRef, maxSize?: number, options?: { priority?: number }): Promise<Blob>;
  /** Original-resolution viewable URL for an `<img>` (streamed for Electron). */
  getViewerUrl(file: FileRef): Promise<string>;
  /** Releases resources held by a viewer URL (no-op for protocol-backed URLs). */
  releaseViewerUrl(url: string): void;
  move(entry: FsEntry, toFolder: FolderRef, newName?: string): Promise<FsEntry>;
  remove(entry: FsEntry): Promise<void>;
  /** Zips targetRelPath (empty = whole library) preserving directory structure. */
  zipLibrary(targetRelPath: string, onProgress?: (done: number, total: number) => void): Promise<ZipExportResult>;
  /**
   * Optional native fast path: copies the whole source tree into the library without
   * round-tripping file bytes through the JS bridge. Android SAF and Electron can both
   * implement this; platforms without it fall back to picker.readBlob + writeBlob.
   */
  importSourceTree?(source: FolderRef, targetTopName: string, onProgress?: (p: NativeImportProgress) => void): Promise<NativeImportResult>;
}
