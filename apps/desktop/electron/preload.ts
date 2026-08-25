// Preload: exposes the desktop bridge to the renderer through contextBridge.
import { contextBridge, ipcRenderer } from 'electron';

type DesktopEntry = {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
  width?: number;
  height?: number;
};

type ThumbnailDebugStats = {
  queuedByPriority: number[];
  inFlight: number;
  workers: number;
  thumbCacheEntries: number;
  thumbCacheBytes: number;
  diskFiles: number;
  debugEnabled: boolean;
};

type ClearCacheResult = {
  memoryEntries: number;
  memoryBytes: number;
  diskFiles: number;
  diskBytes: number;
};

const bridge = {
  platform: 'electron' as const,
  version: '0.1.0',
  getThumbnailDebugStats: (): Promise<ThumbnailDebugStats> => ipcRenderer.invoke('debug:thumbnailStats'),
  setDebugEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke('debug:setEnabled', enabled),
  setLogLevel: (level: 'debug' | 'info' | 'warn' | 'error'): Promise<void> => ipcRenderer.invoke('debug:setLevel', level),
  readLogs: (maxLines?: number): Promise<string[]> => ipcRenderer.invoke('debug:readLogs', maxLines),
  clearCaches: (): Promise<ClearCacheResult> => ipcRenderer.invoke('cache:clear'),
  pickSourceFolder: (): Promise<DesktopEntry | null> => ipcRenderer.invoke('import:pickFolder'),
  listSourceChildren: (folder: DesktopEntry): Promise<DesktopEntry[]> =>
    ipcRenderer.invoke('import:listChildren', folder),
  readSourceBlob: (file: DesktopEntry): Promise<Uint8Array> => ipcRenderer.invoke('import:readBlob', file),
  releaseSource: (): Promise<void> => ipcRenderer.invoke('import:releaseSource'),
  getLibraryRoot: (): Promise<DesktopEntry> => ipcRenderer.invoke('library:getRoot'),
  ensureLibraryRoot: (): Promise<DesktopEntry> => ipcRenderer.invoke('library:ensureRoot'),
  createLibraryFolder: (parent: DesktopEntry, name: string): Promise<DesktopEntry> =>
    ipcRenderer.invoke('library:createFolder', parent, name),
  createTopLibraryFolder: (name: string): Promise<DesktopEntry> =>
    ipcRenderer.invoke('library:createTopFolder', name),
  writeLibraryBlob: (folder: DesktopEntry, name: string, data: Uint8Array): Promise<DesktopEntry> =>
    ipcRenderer.invoke('library:writeBlob', folder, name, data),
  listLibraryChildren: (folder: DesktopEntry): Promise<DesktopEntry[]> =>
    ipcRenderer.invoke('library:listChildren', folder),
  readLibraryBlob: (file: DesktopEntry): Promise<Uint8Array> => ipcRenderer.invoke('library:readBlob', file),
  readLibraryThumbnail: (file: DesktopEntry, maxSize: number, priority?: number): Promise<Uint8Array> =>
    ipcRenderer.invoke('library:readThumbnail', file, maxSize, priority ?? 0),
  moveLibraryEntry: (entry: DesktopEntry, toFolder: DesktopEntry, newName?: string): Promise<DesktopEntry> =>
    ipcRenderer.invoke('library:move', entry, toFolder, newName),
  removeLibraryEntry: (entry: DesktopEntry): Promise<void> => ipcRenderer.invoke('library:remove', entry),
  exportZip: (targetRelPath: string): Promise<{
    canceled: boolean;
    outputPath?: string;
    totalImages?: number;
    exportedCount?: number;
  }> => ipcRenderer.invoke('library:exportZip', targetRelPath),
  getLibraryFingerprint: (): Promise<string> => ipcRenderer.invoke('library:fingerprint'),
  onExportProgress: (callback: (progress: { done: number; total: number }) => void): (() => void) => {
    const listener = (_event: unknown, progress: { done: number; total: number }) => callback(progress);
    ipcRenderer.on('library:exportProgress', listener);
    return () => ipcRenderer.removeListener('library:exportProgress', listener);
  },

  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  maximizeWindowToggle: (): Promise<boolean> => ipcRenderer.invoke('window:maximize-toggle'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void): (() => void) => {
    const listener = (_event: unknown, maximized: boolean) => callback(maximized);
    ipcRenderer.on('window:maximized-changed', listener);
    return () => ipcRenderer.removeListener('window:maximized-changed', listener);
  },
};

contextBridge.exposeInMainWorld('kanituDesktop', bridge);