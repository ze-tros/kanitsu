import type { LibraryStore } from '../../fs-adapter/src/types';
import type { LibrarySnapshot } from './types';
import { scanLibrary, type ScanOptions } from './scan';

/**
 * A persistent store for the library scan index. The renderer keeps this index so
 * that a fresh startup does not need to re-walk the whole on-disk library; it loads
 * the cached snapshot instead. Mutations re-scan the affected library and save.
 */
export interface PersistentIndex {
  /** Returns the cached snapshot, or `null` if none is persisted (e.g. first run). */
  load(): Promise<LibrarySnapshot | null>;
  save(snapshot: LibrarySnapshot): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory index, used for the web demo fallback and for tests. */
export function createMemoryPersistentIndex(): PersistentIndex {
  let current: LibrarySnapshot | null = null;
  return {
    load: async () => current,
    save: async (snapshot) => {
      current = snapshot;
    },
    clear: async () => {
      current = null;
    },
  };
}

/** Load the cached index if present, otherwise scan the library and persist it. */
export async function loadOrScan(store: LibraryStore, index: PersistentIndex, opts?: ScanOptions): Promise<LibrarySnapshot> {
  const enableRaw = opts?.enableRaw ?? false;
  const enableHeif = opts?.enableHeif ?? false;
  // The three probes are independent (IndexedDB read vs. store IPC round-trips);
  // awaiting them sequentially stacks their latencies onto startup.
  const [cached, currentRoot, currentFingerprint] = await Promise.all([
    index.load(),
    store.getLibraryRoot(),
    store.getLibraryFingerprint(),
  ]);
  if (
    cached &&
    cached.fingerprint === currentFingerprint &&
    // RAW / HEIF 收录开关变化时必须重扫:旧索引(未开对应开关)里没有这类文件,
    // 反之亦然,不能靠 fingerprint 察觉。
    (cached.rawScan ?? false) === enableRaw &&
    (cached.heifScan ?? false) === enableHeif
  ) {
    // The library root display name is live metadata (it can change, e.g. through
    // i18n/localization), so never trust the cached root name: refresh it from the
    // store before returning, instead of doing a full re-scan just for a name change.
    const rootNode = cached.folders[cached.rootId];
    if (rootNode) {
      rootNode.name = currentRoot.name;
      return cached;
    }
  }
  const snapshot = await scanLibrary(store, opts);
  await index.save(snapshot);
  return snapshot;
}

/** Rescan the library from disk and persist the fresh index (used after mutations). */
export async function rescanLibrary(store: LibraryStore, index: PersistentIndex, opts?: ScanOptions): Promise<LibrarySnapshot> {
  const snapshot = await scanLibrary(store, opts);
  await index.save(snapshot);
  return snapshot;
}
