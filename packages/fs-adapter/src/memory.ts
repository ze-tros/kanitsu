import type { FileRef, FolderRef, FsEntry, ImportSourcePicker, LibraryStore } from './types';

interface MemNode {
  name: string;
  kind: 'folder' | 'file';
  blob?: Blob;
  mtime?: number;
  children: Map<string, MemNode>;
}

function joinMemPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

function parentPath(path: string): string {
  if (path === '/') return '/';
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function baseName(path: string): string {
  if (path === '/') return '';
  return path.slice(path.lastIndexOf('/') + 1);
}

function toFolderRef(node: MemNode, id: string): FolderRef {
  return { id, name: node.name, kind: 'folder' };
}

function toFileRef(node: MemNode, id: string): FileRef {
  return { id, name: node.name, kind: 'file', size: node.blob?.size ?? 0, mtime: node.mtime ?? 0 };
}

export class MemoryTree {
  root: MemNode;

  constructor(root?: MemNode) {
    this.root = root ?? { name: '', kind: 'folder', children: new Map() };
  }

  private ensureFolder(id: string): MemNode {
    if (id === '/') return this.root;
    const parts = id.split('/').filter(Boolean);
    let cur = this.root;
    for (const part of parts) {
      let next = cur.children.get(part);
      if (!next) {
        next = { name: part, kind: 'folder', children: new Map() };
        cur.children.set(part, next);
      }
      cur = next;
    }
    return cur;
  }

  get(id: string): MemNode | undefined {
    if (id === '/') return this.root;
    const parts = id.split('/').filter(Boolean);
    let cur = this.root;
    for (const part of parts) {
      const next = cur.children.get(part);
      if (!next) return undefined;
      cur = next;
    }
    return cur;
  }

  listChildren(folder: FolderRef): FsEntry[] {
    const node = this.get(folder.id);
    if (!node || node.kind !== 'folder') return [];
    const out: FsEntry[] = [];
    for (const [childName, child] of node.children) {
      const id = joinMemPath(folder.id, childName);
      out.push(child.kind === 'folder' ? toFolderRef(child, id) : toFileRef(child, id));
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
  }

  getOrCreateFolder(parent: FolderRef, name: string): MemNode {
    const p = this.ensureFolder(parent.id);
    let child = p.children.get(name);
    if (!child) {
      child = { name, kind: 'folder', children: new Map() };
      p.children.set(name, child);
    }
    return child;
  }

  createUniqueFolder(parent: FolderRef, name: string): MemNode {
    const p = this.ensureFolder(parent.id);
    let actual = name;
    let i = 2;
    while (p.children.has(actual)) {
      actual = `${name} (${i++})`;
    }
    const child: MemNode = { name: actual, kind: 'folder', children: new Map() };
    p.children.set(actual, child);
    return child;
  }

  putFile(folder: FolderRef, name: string, blob: Blob): MemNode {
    const p = this.ensureFolder(folder.id);
    const child: MemNode = { name, kind: 'file', blob, mtime: Date.now(), children: new Map() };
    p.children.set(name, child);
    return child;
  }

  remove(id: string): void {
    const parent = this.get(parentPath(id));
    if (parent) parent.children.delete(baseName(id));
  }

  move(id: string, toFolder: FolderRef, newName?: string): MemNode | undefined {
    const node = this.get(id);
    if (!node) return undefined;
    const oldParent = this.get(parentPath(id));
    const targetParent = this.ensureFolder(toFolder.id);
    const actualName = newName ?? baseName(id);
    oldParent?.children.delete(baseName(id));
    targetParent.children.set(actualName, node);
    node.name = actualName;
    return node;
  }
}

export class MemoryImportSourcePicker implements ImportSourcePicker {
  private readonly tree: MemoryTree;

  constructor(private readonly root: MemNode) {
    this.tree = new MemoryTree(root);
  }

  static fromDemo(): MemoryImportSourcePicker {
    const tree = new MemoryTree();
    const root = tree.root;

    const manga = tree.getOrCreateFolder({ id: '/', name: '', kind: 'folder' }, 'MangaA');
    const vol1 = tree.getOrCreateFolder({ id: '/MangaA', name: 'MangaA', kind: 'folder' }, 'Vol.01');
    const vol2 = tree.getOrCreateFolder({ id: '/MangaA', name: 'MangaA', kind: 'folder' }, 'Vol.02');
    tree.putFile({ id: '/MangaA/Vol.01', name: 'Vol.01', kind: 'folder' }, 'Attack_on_Titan_Vol.01_p001.jpg', makeSvgBlob('Vol.01 p001', '#3f51b5'));
    tree.putFile({ id: '/MangaA/Vol.01', name: 'Vol.01', kind: 'folder' }, 'Attack_on_Titan_Vol.01_p002.jpg', makeSvgBlob('Vol.01 p002', '#303f9f'));
    tree.putFile({ id: '/MangaA/Vol.02', name: 'Vol.02', kind: 'folder' }, 'Attack_on_Titan_Vol.02_p001.jpg', makeSvgBlob('Vol.02 p001', '#009688'));
    tree.putFile({ id: '/MangaA/Vol.02', name: 'Vol.02', kind: 'folder' }, 'Attack_on_Titan_Vol.02_p002.jpg', makeSvgBlob('Vol.02 p002', '#00796b'));

    const travel = tree.getOrCreateFolder({ id: '/', name: '', kind: 'folder' }, 'Travel');
    tree.putFile({ id: '/Travel', name: 'Travel', kind: 'folder' }, '2024-03-05_trip_001.jpg', makeSvgBlob('Trip 001', '#ff9800'));
    tree.putFile({ id: '/Travel', name: 'Travel', kind: 'folder' }, '2024-03-05_trip_002.jpg', makeSvgBlob('Trip 002', '#f57c00'));
    tree.putFile({ id: '/Travel', name: 'Travel', kind: 'folder' }, '2024-03-06_trip_001.jpg', makeSvgBlob('Trip 003', '#ffc107'));
    tree.putFile({ id: '/Travel', name: 'Travel', kind: 'folder' }, 'cover.jpg', makeSvgBlob('Cover', '#e91e63'));

    const misc = tree.getOrCreateFolder({ id: '/', name: '', kind: 'folder' }, 'Misc');
    tree.putFile({ id: '/Misc', name: 'Misc', kind: 'folder' }, 'pic001.jpg', makeSvgBlob('pic001', '#607d8b'));
    tree.putFile({ id: '/Misc', name: 'Misc', kind: 'folder' }, 'pic002.jpg', makeSvgBlob('pic002', '#546e7a'));
    tree.putFile({ id: '/Misc', name: 'Misc', kind: 'folder' }, 'pic003.jpg', makeSvgBlob('pic003', '#455a64'));

    return new MemoryImportSourcePicker(root);
  }

  async pickFolder(): Promise<FolderRef> {
    return { id: '/', name: this.root.name || 'Demo Album', kind: 'folder' };
  }

  async *listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void> {
    yield* this.tree.listChildren(folder);
  }

  async readBlob(file: FileRef): Promise<Blob> {
    const node = this.tree.get(file.id);
    if (!node || node.kind !== 'file' || !node.blob) throw new Error(`Missing source file: ${file.id}`);
    return node.blob;
  }
}

export class MemoryLibraryStore implements LibraryStore {
  private readonly tree = new MemoryTree();

  async getLibraryRoot(): Promise<FolderRef> {
    return { id: '/', name: 'Albums', kind: 'folder' };
  }

  async ensureLibraryRoot(): Promise<FolderRef> {
    return this.getLibraryRoot();
  }

  async createFolder(parent: FolderRef, name: string): Promise<FolderRef> {
    const node = this.tree.getOrCreateFolder(parent, name);
    return { id: joinMemPath(parent.id, name), name: node.name, kind: 'folder' };
  }

  async createTopFolder(name: string): Promise<FolderRef> {
    const root: FolderRef = { id: '/', name: 'Albums', kind: 'folder' };
    const node = this.tree.createUniqueFolder(root, name);
    return { id: joinMemPath('/', node.name), name: node.name, kind: 'folder' };
  }

  async writeBlob(folder: FolderRef, name: string, blob: Blob): Promise<FileRef> {
    const node = this.tree.putFile(folder, name, blob);
    return { id: joinMemPath(folder.id, name), name, kind: 'file', size: blob.size, mtime: node.mtime };
  }

  async *listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void> {
    yield* this.tree.listChildren(folder);
  }

  async readBlob(file: FileRef): Promise<Blob> {
    const node = this.tree.get(file.id);
    if (!node || node.kind !== 'file' || !node.blob) throw new Error(`Missing library file: ${file.id}`);
    return node.blob;
  }

  async readThumbnail(file: FileRef, _maxSize?: number): Promise<Blob> {
    return this.readBlob(file);
  }

  async move(entry: FsEntry, toFolder: FolderRef, newName?: string): Promise<FsEntry> {
    const node = this.tree.move(entry.id, toFolder, newName);
    if (!node) throw new Error(`Move failed: ${entry.id}`);
    const newId = joinMemPath(toFolder.id, node.name);
    return node.kind === 'folder' ? toFolderRef(node, newId) : toFileRef(node, newId);
  }

  async remove(entry: FsEntry): Promise<void> {
    this.tree.remove(entry.id);
  }

  async zipLibrary(_targetRelPath: string, _onProgress?: (done: number, total: number) => void): Promise<Blob> {
    throw new Error('MemoryLibraryStore.zipLibrary is not implemented yet; use Electron/Android implementation.');
  }
}

function makeSvgBlob(text: string, bg: string, fg = 'white'): Blob {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="100%" height="100%" fill="${bg}"/><text x="50%" y="50%" fill="${fg}" font-size="36" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle">${text}</text></svg>`;
  return new Blob([svg], { type: 'image/svg+xml' });
}