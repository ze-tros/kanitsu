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
}

export type FsEntry = FolderRef | FileRef;
export type Unwatch = () => void;

/** Reads the user-selected source folder during import. */
export interface ImportSourcePicker {
  pickFolder(): Promise<FolderRef>;
  listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void>;
  readBlob(file: FileRef): Promise<Blob>;
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
  ensureLibraryRoot(): Promise<FolderRef>;
  createFolder(parent: FolderRef, name: string): Promise<FolderRef>;
  createTopFolder(name: string): Promise<FolderRef>;
  writeBlob(folder: FolderRef, name: string, blob: Blob): Promise<FileRef>;
  listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void>;
  readBlob(file: FileRef): Promise<Blob>;
  /** Small thumbnail for grids/folder covers. Implementations should avoid loading the full image. */
  readThumbnail(file: FileRef, maxSize?: number): Promise<Blob>;
  /** Original-resolution viewable URL for an `<img>` (streamed for Electron). */
  getViewerUrl(file: FileRef): Promise<string>;
  /** Releases resources held by a viewer URL (no-op for protocol-backed URLs). */
  releaseViewerUrl(url: string): void;
  move(entry: FsEntry, toFolder: FolderRef, newName?: string): Promise<FsEntry>;
  remove(entry: FsEntry): Promise<void>;
  /** Zips targetRelPath (empty = whole library) preserving directory structure. */
  zipLibrary(targetRelPath: string, onProgress?: (done: number, total: number) => void): Promise<ZipExportResult>;
}
