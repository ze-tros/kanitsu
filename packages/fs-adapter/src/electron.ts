import type { FileRef, FolderRef, FsEntry, ImportSourcePicker, LibraryStore, ZipExportResult } from './types';

export interface DesktopFsEntry {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
}

export interface KanituDesktopBridge {
  platform: 'electron';
  version: string;
  pickSourceFolder(): Promise<DesktopFsEntry | null>;
  listSourceChildren(folder: DesktopFsEntry): Promise<DesktopFsEntry[]>;
  readSourceBlob(file: DesktopFsEntry): Promise<Uint8Array>;
  getLibraryRoot(): Promise<DesktopFsEntry>;
  ensureLibraryRoot(): Promise<DesktopFsEntry>;
  createLibraryFolder(parent: DesktopFsEntry, name: string): Promise<DesktopFsEntry>;
  createTopLibraryFolder(name: string): Promise<DesktopFsEntry>;
  writeLibraryBlob(folder: DesktopFsEntry, name: string, data: Uint8Array): Promise<DesktopFsEntry>;
  listLibraryChildren(folder: DesktopFsEntry): Promise<DesktopFsEntry[]>;
  readLibraryBlob(file: DesktopFsEntry): Promise<Uint8Array>;
  readLibraryThumbnail(file: DesktopFsEntry, maxSize: number): Promise<Uint8Array>;
  moveLibraryEntry(entry: DesktopFsEntry, toFolder: DesktopFsEntry, newName?: string): Promise<DesktopFsEntry>;
  removeLibraryEntry(entry: DesktopFsEntry): Promise<void>;
  exportZip(targetRelPath: string): Promise<{
    canceled: boolean;
    outputPath?: string;
    totalImages?: number;
    exportedCount?: number;
  }>;
  minimizeWindow(): Promise<void>;
  maximizeWindowToggle(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximizedChanged(callback: (maximized: boolean) => void): () => void;
}

declare global {
  interface Window {
    kanituDesktop?: KanituDesktopBridge;
  }
}

function toFolderRef(entry: DesktopFsEntry): FolderRef {
  return { id: entry.id, name: entry.name, kind: 'folder' };
}

function toFileRef(entry: DesktopFsEntry): FileRef {
  return { id: entry.id, name: entry.name, kind: 'file', size: entry.size, mtime: entry.mtime };
}

function toEntry(ref: FolderRef | FileRef): DesktopFsEntry {
  return {
    id: ref.id,
    name: ref.name,
    kind: ref.kind,
    size: ref.kind === 'file' ? ref.size : undefined,
    mtime: ref.kind === 'file' ? ref.mtime : undefined,
  };
}

function requireBridge(): KanituDesktopBridge {
  const bridge = window.kanituDesktop;
  if (!bridge) throw new Error('kanituDesktop bridge is not available. Run this code inside the Electron shell.');
  return bridge;
}

/** Electron source folder picker, used only while importing. */
export class ElectronImportSourcePicker implements ImportSourcePicker {
  async pickFolder(): Promise<FolderRef> {
    const entry = await requireBridge().pickSourceFolder();
    if (!entry) throw new Error('Folder selection canceled');
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

  async readThumbnail(file: FileRef, maxSize = 512): Promise<Blob> {
    const data = await requireBridge().readLibraryThumbnail(toEntry(file), maxSize);
    return new Blob([data as BlobPart]);
  }

  async getViewerUrl(file: FileRef): Promise<string> {
    // The main process serves the ORIGINAL file through the guarded kanitu-file protocol.
    return `kanitu-file://file/?p=${encodeURIComponent(file.id)}`;
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

  async zipLibrary(targetRelPath: string, onProgress?: (done: number, total: number) => void): Promise<ZipExportResult> {
    onProgress?.(0, 0);
    const result = await requireBridge().exportZip(targetRelPath);
    if (result.canceled) throw new Error('Export canceled');
    onProgress?.(result.exportedCount ?? 0, result.totalImages ?? 0);
    return {
      kind: 'file',
      outputPath: result.outputPath,
      totalImages: result.totalImages ?? 0,
      exportedCount: result.exportedCount ?? 0,
    };
  }
}