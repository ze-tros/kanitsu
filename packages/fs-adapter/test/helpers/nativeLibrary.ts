/**
 * 契约测试共用的「原生侧」mock：一棵平台无关的图库树 + 两个桥工厂。
 *
 * - androidPlugin(native)：模拟 KanitsuPlugin 的插件级 API。数据面与 Java 一致
 *   （Base64 字符串、无空白 padding），配合 esbuild --alias:@capacitor/core 指向
 *   capacitorMock，使 android.ts 里真实的桥接线（含 base64 编解码）被端到端覆盖。
 * - electronBridge(native)：模拟 main.ts 的 IPC 数据面（Uint8Array 直接过桥）。
 *
 * 语义对齐真实平台：文件占用路径不能当目录（ENOTDIR/EEXIST）、目录不能被文件
 * 覆盖（EISDIR）、readSlice 越过文件尾返回更短片段、move 目标已存在报错。
 */

export interface NativeFile {
  kind: 'file';
  name: string;
  data: Uint8Array;
  mtime: number;
}
export interface NativeFolder {
  kind: 'folder';
  name: string;
  children: Map<string, NativeNode>;
}
export type NativeNode = NativeFile | NativeFolder;

export interface NativeEntry {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
}

let mtimeTick = 1;

export function createNativeLibrary(): { root: NativeFolder } {
  return { root: { kind: 'folder', name: '', children: new Map() } };
}

function assertEntryName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`非法名称：${JSON.stringify(name)}`);
  }
}

function nodeToEntry(id: string, node: NativeNode): NativeEntry {
  return node.kind === 'file'
    ? { id, name: node.name, kind: 'file', size: node.data.length, mtime: node.mtime }
    : { id, name: node.name, kind: 'folder' };
}

function resolve(native: { root: NativeFolder }, id: string): NativeNode | undefined {
  if (id === '/' || id === '') return native.root;
  let cur: NativeNode = native.root;
  for (const part of id.split('/').filter(Boolean)) {
    if (cur.kind !== 'folder') return undefined;
    const next = cur.children.get(part);
    if (!next) return undefined;
    cur = next;
  }
  return cur;
}

/** 逐段解析并保证每一层都是目录（对齐 ensureFolder 的 kind 断言 / ENOTDIR）。 */
function resolveFolder(native: { root: NativeFolder }, id: string): NativeFolder {
  let cur: NativeNode = native.root;
  for (const part of id.split('/').filter(Boolean)) {
    if (cur.kind !== 'folder') throw new Error(`路径中存在同名文件，无法作为目录使用：${part}`);
    const next = cur.children.get(part);
    if (!next) throw new Error(`未找到图包：${id}`);
    cur = next;
  }
  if (cur.kind !== 'folder') throw new Error(`不是目录：${id}`);
  return cur;
}

function listChildren(native: { root: NativeFolder }, id: string): NativeEntry[] {
  const node = resolve(native, id);
  if (!node || node.kind !== 'folder') throw new Error(`未找到图包：${id}`);
  const out: NativeEntry[] = [];
  for (const [name, child] of node.children) {
    out.push(nodeToEntry(`${id === '/' ? '' : id}/${name}`, child));
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
}

function createFolder(native: { root: NativeFolder }, parentId: string, name: string): NativeEntry {
  assertEntryName(name);
  const parent = resolveFolder(native, parentId);
  const existing = parent.children.get(name);
  if (existing) {
    if (existing.kind !== 'folder') throw new Error(`已存在同名文件，无法创建图包：${name}`);
    return nodeToEntry(joinId(parentId, name), existing);
  }
  const folder: NativeFolder = { kind: 'folder', name, children: new Map() };
  parent.children.set(name, folder);
  return nodeToEntry(joinId(parentId, name), folder);
}

function joinId(parentId: string, name: string): string {
  return `${parentId === '/' ? '' : parentId}/${name}`;
}

function write(native: { root: NativeFolder }, folderId: string, name: string, bytes: Uint8Array): NativeEntry {
  assertEntryName(name);
  const parent = resolveFolder(native, folderId);
  const existing = parent.children.get(name);
  if (existing && existing.kind !== 'file') throw new Error(`已存在同名目录，无法写入文件：${name}`);
  const file: NativeFile = { kind: 'file', name, data: bytes.slice(), mtime: mtimeTick++ };
  parent.children.set(name, file);
  return nodeToEntry(joinId(folderId, name), file);
}

function readSliceBytes(file: NativeFile, offset: number, length: number): Uint8Array {
  const start = Math.max(0, Math.min(Math.floor(offset), file.data.length));
  const end = Math.max(start, Math.min(start + Math.max(0, Math.floor(length)), file.data.length));
  return file.data.slice(start, end);
}

function move(native: { root: NativeFolder }, entryId: string, toFolderId: string, newName?: string): NativeEntry {
  const node = resolve(native, entryId);
  if (!node) throw new Error(`未找到条目：${entryId}`);
  const toFolder = resolveFolder(native, toFolderId);
  const name = newName ?? node.name;
  assertEntryName(name);
  if (toFolder.children.get(name)) throw new Error(`目标已存在：${name}`);
  const oldParent = resolveFolder(native, parentOf(entryId));
  oldParent.children.delete(baseName(entryId));
  node.name = name;
  toFolder.children.set(name, node);
  return nodeToEntry(joinId(toFolderId, name), node);
}

function remove(native: { root: NativeFolder }, entryId: string): void {
  const parent = resolve(native, parentOf(entryId));
  if (!parent || parent.kind !== 'folder') throw new Error(`未找到父目录：${entryId}`);
  parent.children.delete(baseName(entryId));
}

function fingerprint(native: { root: NativeFolder }): string {
  const parts: string[] = [];
  for (const [name, child] of native.root.children) parts.push(`${child.kind}:${name}`);
  return parts.join('|');
}

function parentOf(id: string): string {
  const idx = id.lastIndexOf('/');
  return idx <= 0 ? '/' : id.slice(0, idx);
}

function baseName(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

export interface NativeLibrary {
  root: NativeFolder;
  listChildren(folderId: string): NativeEntry[];
  createFolder(folderId: string, name: string): NativeEntry;
  write(folderId: string, name: string, bytes: Uint8Array): NativeEntry;
  read(fileId: string): NativeFile;
  readSlice(fileId: string, offset: number, length: number): Uint8Array;
  move(entryId: string, toFolderId: string, newName?: string): NativeEntry;
  remove(entryId: string): void;
  fingerprint(): string;
}

export function createNativeApi(): NativeLibrary {
  const native = createNativeLibrary();
  return {
    root: native.root,
    listChildren: (id) => listChildren(native, id),
    createFolder: (id, name) => createFolder(native, id, name),
    write: (id, name, bytes) => write(native, id, name, bytes),
    read: (fileId) => {
      const node = resolve(native, fileId);
      if (!node || node.kind !== 'file') throw new Error(`未找到文件：${fileId}`);
      return node;
    },
    readSlice: (fileId, offset, length) => {
      const node = resolve(native, fileId);
      if (!node || node.kind !== 'file') throw new Error(`未找到文件：${fileId}`);
      return readSliceBytes(node, offset, length);
    },
    move: (entryId, toFolderId, newName) => move(native, entryId, toFolderId, newName),
    remove: (entryId) => remove(native, entryId),
    fingerprint: () => fingerprint(native),
  };
}

// —— Android 插件级 mock：数据面与 KanitsuPlugin.java 一致（base64 字符串） ——

export interface AndroidPluginShape {
  getLibraryRoot(): Promise<NativeEntry>;
  ensureLibraryRoot(): Promise<NativeEntry>;
  createLibraryFolder(options: { parent: NativeEntry; name: string }): Promise<NativeEntry>;
  createTopLibraryFolder(options: { name: string }): Promise<NativeEntry>;
  writeLibraryBlob(options: { folder: NativeEntry; name: string; data: string }): Promise<NativeEntry>;
  listLibraryChildren(options: { folder: NativeEntry }): Promise<{ entries: NativeEntry[] }>;
  readLibraryBlob(options: { file: NativeEntry }): Promise<{ data: string; mime?: string }>;
  readLibrarySlice(options: { file: NativeEntry; offset: number; length: number }): Promise<{ data: string }>;
  readLibraryThumbnail(options: { file: NativeEntry; maxSize: number; priority: number; gifAnimated: boolean }): Promise<{ data: string; mime?: string }>;
  moveLibraryEntry(options: { entry: NativeEntry; toFolder: NativeEntry; newName?: string }): Promise<NativeEntry>;
  removeLibraryEntry(options: { entry: NativeEntry }): Promise<void>;
  getLibraryFingerprint(): Promise<{ fingerprint: string }>;
  getViewerUrl(options: { file: NativeEntry }): Promise<{ url: string }>;
  ensureViewerDerivative(options: { file: NativeEntry }): Promise<{ url: string }>;
  cancelTask(options: { token: string }): Promise<void>;
  addListener(eventName: string, listener: unknown): Promise<{ remove: () => void }>;
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** 与 AndroidLibraryStore 桥接线对接的插件 mock（registerPlugin 的返回值）。
 *  bridgePromise 是模块级缓存：所有用例共享同一个 mock 实例，用 resetNative()
 *  在用例之间换新树，保证用例隔离。 */
export function createAndroidPluginMock(): AndroidPluginShape & { native: NativeLibrary; resetNative(): void } {
  let native = createNativeApi();
  const rootEntry = (): NativeEntry => ({ id: '/', name: '图库', kind: 'folder' });
  return {
    get native() {
      return native;
    },
    resetNative: () => {
      native = createNativeApi();
    },
    getLibraryRoot: async () => rootEntry(),
    ensureLibraryRoot: async () => rootEntry(),
    createLibraryFolder: async ({ parent, name }) => native.createFolder(parent.id, name),
    createTopLibraryFolder: async ({ name }) => {
      // 对齐 createUniqueTopFolder：重名时追加序号。
      let actual = name;
      for (let i = 2; native.root.children.has(actual); i++) actual = `${name} (${i})`;
      return native.createFolder('/', actual);
    },
    writeLibraryBlob: async ({ folder, name, data }) => native.write(folder.id, name, fromB64(data)),
    listLibraryChildren: async ({ folder }) => ({ entries: native.listChildren(folder.id) }),
    readLibraryBlob: async ({ file }) => ({ data: toB64(native.read(file.id).data), mime: 'image/jpeg' }),
    readLibrarySlice: async ({ file, offset, length }) => ({ data: toB64(native.readSlice(file.id, offset, length)) }),
    readLibraryThumbnail: async ({ file }) => ({ data: toB64(native.read(file.id).data), mime: 'image/jpeg' }),
    moveLibraryEntry: async ({ entry, toFolder, newName }) => native.move(entry.id, toFolder.id, newName),
    removeLibraryEntry: async ({ entry }) => native.remove(entry.id),
    getLibraryFingerprint: async () => ({ fingerprint: native.fingerprint() }),
    getViewerUrl: async ({ file }) => ({ url: `kanitsu-file://${file.id}` }),
    ensureViewerDerivative: async ({ file }) => ({ url: `kanitsu-deriv://${file.id}` }),
    cancelTask: async () => undefined,
    addListener: async () => ({ remove: () => undefined }),
  };
}

// —— Electron IPC mock：数据面与 main.ts 一致（Uint8Array 直接过桥） ——

export interface ElectronBridgeShape {
  platform: 'electron';
  version: string;
  getLibraryRoot(): Promise<NativeEntry>;
  ensureLibraryRoot(): Promise<NativeEntry>;
  createLibraryFolder(parent: NativeEntry, name: string): Promise<NativeEntry>;
  createTopLibraryFolder(name: string): Promise<NativeEntry>;
  writeLibraryBlob(folder: NativeEntry, name: string, data: Uint8Array): Promise<NativeEntry>;
  listLibraryChildren(folder: NativeEntry): Promise<NativeEntry[]>;
  readLibraryBlob(file: NativeEntry): Promise<Uint8Array>;
  readLibrarySlice(file: NativeEntry, offset: number, length: number): Promise<Uint8Array>;
  readLibraryThumbnail(file: NativeEntry, maxSize: number, priority?: number, gifAnimated?: boolean): Promise<Uint8Array>;
  moveLibraryEntry(entry: NativeEntry, toFolder: NativeEntry, newName?: string): Promise<NativeEntry>;
  removeLibraryEntry(entry: NativeEntry): Promise<void>;
  getLibraryFingerprint(): Promise<string>;
  getViewerUrl(file: NativeEntry): Promise<string>;
}

export function createElectronBridgeMock(): ElectronBridgeShape & { native: NativeLibrary } {
  const native = createNativeApi();
  const rootEntry = (): NativeEntry => ({ id: '/', name: '图库', kind: 'folder' });
  return {
    native,
    platform: 'electron',
    version: '0.0.0-test',
    getLibraryRoot: async () => rootEntry(),
    ensureLibraryRoot: async () => rootEntry(),
    createLibraryFolder: async (parent, name) => native.createFolder(parent.id, name),
    createTopLibraryFolder: async (name) => native.createFolder('/', name),
    writeLibraryBlob: async (folder, name, data) => native.write(folder.id, name, data),
    listLibraryChildren: async (folder) => native.listChildren(folder.id),
    readLibraryBlob: async (file) => native.read(file.id).data,
    readLibrarySlice: async (file, offset, length) => native.readSlice(file.id, offset, length),
    readLibraryThumbnail: async (file) => native.read(file.id).data,
    moveLibraryEntry: async (entry, toFolder, newName) => native.move(entry.id, toFolder.id, newName),
    removeLibraryEntry: async (entry) => native.remove(entry.id),
    getLibraryFingerprint: async () => native.fingerprint(),
    getViewerUrl: async (file) => `kanitsu-file://${file.id}`,
  };
}

/** 确定性伪随机字节（mulberry32），避免测试对 Math.random 的不可复现依赖。 */
export function pseudoRandomBytes(length: number, seed = 0x9e3779b9): Uint8Array {
  let a = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}
