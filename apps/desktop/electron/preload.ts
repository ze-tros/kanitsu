// Preload: exposes the desktop bridge to the renderer through contextBridge.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

// 启动底色引导：preload 与页面同源，localStorage 同步可读且早于一切页面
// 脚本。这里把解析后的主题发给主进程，主进程在窗口显示（ready-to-show）
// 前据此设置 backgroundColor，消除"系统浅色 + 应用暗色"等主题不匹配组合
// 下的启动闪白。解析口径与 LibraryBrowser / index.html 内联脚本一致。
const bootTheme: 'dark' | 'light' = (() => {
  try {
    const saved = localStorage.getItem('kanitsu-theme');
    const dark = saved === 'dark'
      || (saved !== 'light' && !window.matchMedia('(prefers-color-scheme: light)').matches);
    return dark ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
})();
ipcRenderer.send('theme:bootstrap', bootTheme);

type DesktopEntry = {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
  width?: number;
  height?: number;
};

type NativeImportResult = {
  canceled?: boolean;
  targetTopFolder: string;
  scannedFileCount: number;
  copiedImageCount: number;
  skippedCount: number;
  skippedFiles: Array<{ path: string; reason: 'no-extension' | 'unsupported-format' }>;
  errors: string[];
};

type ThumbnailDebugStats = {
  queuedByPriority: number[];
  inFlight: number;
  workers: number;
  thumbCacheEntries: number;
  thumbCacheBytes: number;
  diskFiles: number;
};

type ClearCacheResult = {
  memoryEntries: number;
  memoryBytes: number;
  diskFiles: number;
  diskBytes: number;
};

type DataDirChoice = {
  canceled: boolean;
  path?: string;
  error?: string;
};

type DataDirConfirmResult = {
  ok: boolean;
  error?: string;
};

const bridge = {
  platform: 'electron' as const,
  // 版本号由主进程经 additionalArguments 传入（app.getVersion()，即 apps/desktop/package.json）。
  version: process.argv.find((arg) => arg.startsWith('--kanitsu-version='))?.slice('--kanitsu-version='.length) ?? '',
  getThumbnailDebugStats: (): Promise<ThumbnailDebugStats> => ipcRenderer.invoke('debug:thumbnailStats'),
  setLogLevel: (level: 'debug' | 'info' | 'warn' | 'error'): Promise<void> => ipcRenderer.invoke('debug:setLevel', level),
  readLogs: (maxLines?: number): Promise<string[]> => ipcRenderer.invoke('debug:readLogs', maxLines),
  clearCaches: (): Promise<ClearCacheResult> => ipcRenderer.invoke('cache:clear'),
  pickSourceFolder: (): Promise<DesktopEntry | null> => ipcRenderer.invoke('import:pickFolder'),
  // 拖入导入：File 对象无法跨 IPC 传给主进程，这里用 webUtils 取绝对路径后交给主进程；
  // 主进程会弹原生确认框，用户确认后才授权该目录。非 File 或无本地路径时直接拒绝。
  resolveDroppedFolder: (file: File): Promise<DesktopEntry> => {
    let droppedPath = '';
    try {
      droppedPath = webUtils.getPathForFile(file);
    } catch {
      droppedPath = '';
    }
    if (!droppedPath) return Promise.reject(new Error('无法识别拖入的项目，请拖入本地文件夹。'));
    return ipcRenderer.invoke('import:confirmDrop', droppedPath);
  },
  listSourceChildren: (folder: DesktopEntry): Promise<DesktopEntry[]> =>
    ipcRenderer.invoke('import:listChildren', folder),
  readSourceBlob: (file: DesktopEntry): Promise<Uint8Array> => ipcRenderer.invoke('import:readBlob', file),
  importSourceTree: (source: DesktopEntry, targetTopName: string, cancelToken?: string): Promise<NativeImportResult> =>
    ipcRenderer.invoke('import:tree', source, targetTopName, cancelToken),
  onImportProgress: (callback: (progress: { scanned: number; copied: number; skipped: number; current?: string }) => void): (() => void) => {
    const listener = (_event: unknown, progress: { scanned: number; copied: number; skipped: number; current?: string }) => callback(progress);
    ipcRenderer.on('import:progress', listener);
    return () => ipcRenderer.removeListener('import:progress', listener);
  },
  cancelTask: (token: string): Promise<void> => ipcRenderer.invoke('import:cancel', token),
  releaseSource: (): Promise<void> => ipcRenderer.invoke('import:releaseSource'),
  // 数据目录：首次启动引导（仅桌面端）。确认成功后主进程直接打开主窗口。
  getDataDir: (): Promise<string> => ipcRenderer.invoke('dataDir:get'),
  chooseDataDir: (): Promise<DataDirChoice> => ipcRenderer.invoke('dataDir:choose'),
  confirmDataDir: (path: string): Promise<DataDirConfirmResult> => ipcRenderer.invoke('dataDir:confirm', path),
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
  // 原始文件字节区间（元数据解析用；readBlob 是重编码后的展示图）。
  readLibrarySlice: (file: DesktopEntry, offset: number, length: number): Promise<Uint8Array> =>
    ipcRenderer.invoke('library:readSlice', file, offset, length),
  readLibraryThumbnail: (file: DesktopEntry, maxSize: number, priority?: number): Promise<Uint8Array> =>
    ipcRenderer.invoke('library:readThumbnail', file, maxSize, priority ?? 0),
  // RAW 查看派生图:主进程按渲染端传入的查看模式(缺省用持久值)解码后返回
  // 派生 JPEG 的 kanitsu-file URL。
  ensureRawDerivative: (file: DesktopEntry, viewMode?: 'camera' | 'developed'): Promise<string> =>
    ipcRenderer.invoke('raw:ensureDerivative', file, viewMode),
  // 派生文件的完整解码是否已完成(developed 模式查看器的加载指示依据)。
  isRawDerivativeFullDone: (derivPath: string): Promise<boolean> =>
    ipcRenderer.invoke('raw:isFullDone', derivPath),
  // RAW 查看模式:设置页变更时推送主进程(持久化),及启动时回读。
  setRawViewMode: (mode: 'camera' | 'developed'): Promise<void> => ipcRenderer.invoke('raw:setViewMode', mode),
  getRawViewMode: (): Promise<'camera' | 'developed'> => ipcRenderer.invoke('raw:getViewMode'),
  // 查询派生文件属于哪个查看模式的缓存(渲染端过滤热替换事件用)。
  getRawDerivativeViewMode: (derivPath: string): Promise<'camera' | 'developed' | null> =>
    ipcRenderer.invoke('raw:getDerivativeViewMode', derivPath),
  // RAW 完整解码在后台覆盖预览级派生后推送(渲染端热替换当前图)。
  onRawDerivativeUpdated: (callback: (info: { derivPath: string }) => void): (() => void) => {
    const listener = (_event: unknown, info: { derivPath: string }) => callback(info);
    ipcRenderer.on('raw:derivativeUpdated', listener);
    return () => ipcRenderer.removeListener('raw:derivativeUpdated', listener);
  },
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

contextBridge.exposeInMainWorld('kanitsuDesktop', bridge);
