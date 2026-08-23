// Preload: exposes the desktop bridge to the renderer through contextBridge.
import { contextBridge, ipcRenderer } from 'electron';

type DesktopEntry = {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
};

const bridge = {
  platform: 'electron' as const,
  version: '0.1.0',
  pickSourceFolder: (): Promise<DesktopEntry | null> => ipcRenderer.invoke('import:pickFolder'),
  listSourceChildren: (folder: DesktopEntry): Promise<DesktopEntry[]> =>
    ipcRenderer.invoke('import:listChildren', folder),
  readSourceBlob: (file: DesktopEntry): Promise<Uint8Array> => ipcRenderer.invoke('import:readBlob', file),
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
  readLibraryThumbnail: (file: DesktopEntry, maxSize: number): Promise<Uint8Array> =>
    ipcRenderer.invoke('library:readThumbnail', file, maxSize),
  moveLibraryEntry: (entry: DesktopEntry, toFolder: DesktopEntry, newName?: string): Promise<DesktopEntry> =>
    ipcRenderer.invoke('library:move', entry, toFolder, newName),
  removeLibraryEntry: (entry: DesktopEntry): Promise<void> => ipcRenderer.invoke('library:remove', entry),
};

contextBridge.exposeInMainWorld('kanituDesktop', bridge);