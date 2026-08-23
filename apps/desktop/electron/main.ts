// Electron main process: native file system for import and album library.
import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

let libraryRoot = '';
const allowedSourceRoots = new Set<string>();

interface DesktopFsEntry {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
}

function getLibraryRoot(): string {
  if (!libraryRoot) libraryRoot = path.join(app.getPath('userData'), 'albums');
  return libraryRoot;
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

function assertInsideLibrary(p: string): void {
  const root = path.resolve(getLibraryRoot());
  const target = path.resolve(p);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path is outside library: ${p}`);
  }
}

function assertSourceAllowed(p: string): void {
  const target = path.resolve(p);
  for (const root of allowedSourceRoots) {
    const r = path.resolve(root);
    if (target === r || target.startsWith(r + path.sep)) return;
  }
  throw new Error(`Path is outside selected source folder: ${p}`);
}

async function entryFor(fullPath: string, name?: string): Promise<DesktopFsEntry> {
  const stat = await fs.stat(fullPath);
  const isDir = stat.isDirectory();
  return {
    id: fullPath,
    name: name ?? path.basename(fullPath),
    kind: isDir ? 'folder' : 'file',
    ...(isDir ? {} : { size: stat.size, mtime: stat.mtimeMs }),
  };
}

async function listEntries(dirPath: string): Promise<DesktopFsEntry[]> {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const entries: DesktopFsEntry[] = [];
  for (const dirent of dirents) {
    const full = path.join(dirPath, dirent.name);
    const stat = await fs.stat(full);
    entries.push({
      id: full,
      name: dirent.name,
      kind: dirent.isDirectory() ? 'folder' : 'file',
      ...(dirent.isDirectory() ? {} : { size: stat.size, mtime: stat.mtimeMs }),
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

function registerIpc(): void {
  // Source picker (import only)
  ipcMain.handle('import:pickFolder', async (): Promise<DesktopFsEntry | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Select a folder to import',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selected = path.resolve(result.filePaths[0]!);
    allowedSourceRoots.add(selected);
    return entryFor(selected);
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

  // Album library (app-managed copy)
  ipcMain.handle('library:getRoot', async (): Promise<DesktopFsEntry> => {
    const root = getLibraryRoot();
    await ensureDir(root);
    return entryFor(root, 'Albums');
  });

  ipcMain.handle('library:ensureRoot', async (): Promise<DesktopFsEntry> => {
    const root = getLibraryRoot();
    await ensureDir(root);
    return entryFor(root, 'Albums');
  });

  ipcMain.handle('library:createFolder', async (_event, parent: DesktopFsEntry, name: string): Promise<DesktopFsEntry> => {
    return getOrCreateFolder(parent.id, name);
  });

  ipcMain.handle('library:createTopFolder', async (_event, name: string): Promise<DesktopFsEntry> => {
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
    return listEntries(folder.id);
  });

  ipcMain.handle('library:readBlob', async (_event, file: DesktopFsEntry): Promise<Uint8Array> => {
    assertInsideLibrary(file.id);
    const ext = path.extname(file.id).toLowerCase();
    // Keep GIF animation by returning the original file; GIFs are usually small.
    if (ext === '.gif') {
      return await fs.readFile(file.id);
    }
    // For full-size viewing, decode natively and return a capped preview.
    // This avoids allocating a giant JS Buffer for very large photos.
    const image = nativeImage.createFromPath(file.id);
    if (image.isEmpty()) {
      throw new Error(`Cannot decode image: ${file.id}`);
    }
    const size = image.getSize();
    const maxDim = 2560;
    const scale = Math.min(1, maxDim / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const resized = image.resize({ width, height, quality: 'good' });
    return ext === '.png' ? resized.toPNG() : resized.toJPEG(85);
  });

  ipcMain.handle('library:readThumbnail', async (_event, file: DesktopFsEntry, maxSize: number): Promise<Uint8Array> => {
    assertInsideLibrary(file.id);
    const image = nativeImage.createFromPath(file.id);
    if (image.isEmpty()) {
      throw new Error(`Cannot decode image: ${file.id}`);
    }
    const targetSize = Math.max(64, Math.min(maxSize || 512, 1024));
    const resized = image.resize({ width: targetSize, height: targetSize, quality: 'good' });
    return resized.toJPEG(80);
  });

  ipcMain.handle('library:move', async (_event, entry: DesktopFsEntry, toFolder: DesktopFsEntry, newName?: string): Promise<DesktopFsEntry> => {
    assertInsideLibrary(entry.id);
    assertInsideLibrary(toFolder.id);
    const target = path.join(toFolder.id, newName ?? path.basename(entry.id));
    await fs.rename(entry.id, target);
    return entryFor(target);
  });

  ipcMain.handle('library:remove', async (_event, entry: DesktopFsEntry): Promise<void> => {
    assertInsideLibrary(entry.id);
    await fs.rm(entry.id, { recursive: true, force: true });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Avoid stale renderer bundles during development.
  void win.webContents.session.clearCache();

  if (process.env.VITE_DEV_SERVER_URL) {
    const url = process.env.VITE_DEV_SERVER_URL;
    const cacheBust = `v=${Date.now()}`;
    void win.loadURL(url.includes('?') ? `${url}&${cacheBust}` : `${url}?${cacheBust}`);
  } else {
    // In a packaged build this path should point to the web app output.
    void win.loadFile(path.join(__dirname, '../../web/dist/index.html'));
  }
}

void app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});