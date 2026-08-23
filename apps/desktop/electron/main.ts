// Electron main process: native file system for import and album library.
import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol } from 'electron';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import archiver from 'archiver';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif']);

interface FsFileMeta {
  relPath: string;
  size: number;
  mtime: number;
}

/** Walks a library subtree, counting images and collecting archive-relative metadata. */
async function collectLibraryFiles(dirPath: string, root: string, out: FsFileMeta[]): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      count += await collectLibraryFiles(full, root, out);
    } else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase().slice(1))) {
      const stat = await fs.stat(full);
      const rel = path.relative(root, full).split(path.sep).join('/');
      out.push({ relPath: rel, size: stat.size, mtime: stat.mtimeMs });
      count++;
    }
  }
  return count;
}

const indexBase = (relPath: string): string => (relPath.lastIndexOf('/') < 0 ? relPath : relPath.slice(relPath.lastIndexOf('/') + 1));
const indexParent = (relPath: string): string => {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
};
const indexExt = (relPath: string): string => {
  const i = relPath.lastIndexOf('.');
  return i < 0 ? '' : relPath.slice(i + 1).toLowerCase();
};

/** JSON index embedded into exported zips (mirrors fs-adapter/src/exportIndex.ts). */
function buildIndexJson(root: string, files: FsFileMeta[], exportedAt = Date.now()): string {
  const images = files
    .map((f) => ({ relPath: f.relPath, name: indexBase(f.relPath), size: f.size, mtime: f.mtime, ext: indexExt(f.relPath) }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  const folderSet = new Set<string>();
  for (const image of images) {
    let p = indexParent(image.relPath);
    while (p && !folderSet.has(p)) {
      folderSet.add(p);
      p = indexParent(p);
    }
  }
  const folders = [...folderSet]
    .sort((a, b) => a.localeCompare(b))
    .map((relPath) => ({
      relPath,
      name: indexBase(relPath),
      directImageCount: images.filter((x) => indexParent(x.relPath) === relPath).length,
      imageCount: images.filter((x) => x.relPath.startsWith(`${relPath}/`)).length,
      childCount: [...folderSet].filter((x) => indexParent(x) === relPath).length,
    }));
  return JSON.stringify({ version: 1, exportedAt, root, folders, images });
}

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

  // Export a folder (or the whole library) as a ZIP. Streams to a user-chosen path
  // so large libraries don't buffer entirely in memory. Uses STORE (no compression).
  ipcMain.handle('library:exportZip', async (_event, targetRelPath: string) => {
    const libraryRoot = getLibraryRoot();
    await ensureDir(libraryRoot);
    const norm = String(targetRelPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const sourceDir = norm ? path.join(libraryRoot, ...norm.split('/')) : libraryRoot;
    assertInsideLibrary(sourceDir);
    const baseName = norm ? path.basename(norm) : 'albums';

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export album as ZIP',
      defaultPath: path.join(app.getPath('desktop'), `${baseName}.zip`),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return { canceled: true };

    const files: FsFileMeta[] = [];
    const totalImages = await collectLibraryFiles(sourceDir, libraryRoot, files);
    const indexRoot = norm ? baseName : '';

    const output = createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 0 } });
    const done = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      output.on('error', reject);
      archive.on('error', reject);
    });

    archive.pipe(output);
    if (norm) archive.directory(sourceDir, baseName);
    else archive.directory(sourceDir, false);
    // Embed a portable index describing the exported folder tree + image metadata.
    archive.append(Buffer.from(buildIndexJson(indexRoot, files)), { name: 'index.json' });
    await archive.finalize();
    await done;

    return { canceled: false, outputPath: filePath, totalImages, exportedCount: totalImages };
  });
}

/**
 * Registers a guarded `kanitu-file://` protocol so the renderer can display the
 * ORIGINAL image (no 2560px cap, no giant IPC buffer): Chromium streams and decodes
 * the file natively. Only files inside the library are served.
 */
function registerViewerProtocol(): void {
  protocol.handle('kanitu-file', async (request) => {
    const filePath = new URL(request.url).searchParams.get('p');
    if (!filePath) return new Response('Bad request', { status: 400 });
    try {
      assertInsideLibrary(filePath);
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
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
  registerViewerProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});