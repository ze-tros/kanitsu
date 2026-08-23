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
  move(entry: FsEntry, toFolder: FolderRef, newName?: string): Promise<FsEntry>;
  remove(entry: FsEntry): Promise<void>;
  /** Zips targetRelPath (empty = whole library) preserving directory structure. */
  zipLibrary(targetRelPath: string, onProgress?: (done: number, total: number) => void): Promise<Blob>;
}
