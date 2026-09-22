export interface FolderNode {
  id: string;
  parentId: string | null;
  name: string;
  relPath: string;
  /** Total images in this folder and all descendant folders. */
  imageCount: number;
  /** Images directly inside this folder (not including subfolders). */
  directImageCount: number;
  /** Direct child folder count. */
  childCount: number;
  coverImageId?: string;
}

export interface ImageEntry {
  id: string;
  folderId: string;
  name: string;
  relPath: string;
  ext: string;
  size: number;
  mtime: number;
  width?: number;
  height?: number;
  fileRefId?: string;
}

export interface ImportSkippedFile {
  path: string;
  reason: 'no-extension' | 'unsupported-format';
}

export interface ImportTask {
  id: string;
  sourceFolderName: string;
  targetTopFolder: string;
  status: 'picking' | 'scanning' | 'copying' | 'indexing' | 'done' | 'failed' | 'canceled';
  scannedFileCount: number;
  copiedImageCount: number;
  skippedCount: number;
  skippedFiles: ImportSkippedFile[];
  errors: string[];
  createdAt: number;
  finishedAt?: number;
}

export interface ExportTask {
  id: string;
  target: string;
  status: 'pending' | 'zipping' | 'done' | 'failed';
  outputPath?: string;
  totalImageCount: number;
  processedCount: number;
  createdAt: number;
}

export interface OrganizeRule {
  id: string;
  name: string;
  kind: 'separator' | 'chapter' | 'date' | 'author' | 'regex' | 'commonPrefix';
  config: Record<string, unknown>;
  enabled: boolean;
  priority: number;
}

export interface OrganizeBinding {
  imageId: string;
  virtualPath: string;
  confidence: number;
  materialized: boolean;
}

export interface LibrarySnapshot {
  rootId: string;
  folders: Record<string, FolderNode>;
  images: Record<string, ImageEntry>;
  /** Platform fingerprint captured at scan time; used to invalidate stale indexes. */
  fingerprint?: string;
  /** 本次扫描是否收录 RAW(见 scanLibrary 的 enableRaw 选项);缓存命中校验用。 */
  rawScan?: boolean;
}

export interface SyncProvider {
  readonly id: string;
  upload(exportZip: Blob, meta: unknown): Promise<void>;
  download(id: string): Promise<Blob>;
}