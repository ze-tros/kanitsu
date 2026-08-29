import type { FolderNode, ImageEntry, LibrarySnapshot } from './types';
import type { PersistentIndex } from './library';

const DB_NAME = 'kanitsu-index';
const DB_VERSION = 2;
const FOLDERS = 'folders';
const IMAGES = 'images';
const META = 'meta';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v2 changed image id generation; drop any stale index rows so the next
      // load falls back to a fresh disk scan instead of mixing old ids.
      for (const name of [FOLDERS, IMAGES, META]) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      }
      db.createObjectStore(FOLDERS, { keyPath: 'id' });
      db.createObjectStore(IMAGES, { keyPath: 'id' });
      db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function requestAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB tx failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB tx aborted'));
  });
}

function clear(store: IDBObjectStore): Promise<void> {
  return requestAsPromise(store.clear());
}

/** IndexedDB-backed persistent index. Falls back gracefully if storage is unavailable. */
export function createIdbPersistentIndex(): PersistentIndex {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const getDb = () => (dbPromise ??= openDb());

  return {
    async load() {
      try {
        const db = await getDb();
        const tx = db.transaction([FOLDERS, IMAGES, META], 'readonly');
        const foldersReq = tx.objectStore(FOLDERS).getAll();
        const imagesReq = tx.objectStore(IMAGES).getAll();
        const rootIdReq = tx.objectStore(META).get('rootId');
        const [folders, images, rootId] = await Promise.all([
          requestAsPromise(foldersReq),
          requestAsPromise(imagesReq),
          requestAsPromise(rootIdReq),
        ]);
        await txDone(tx);
        if (typeof rootId !== 'string') return null;

        const folderMap: Record<string, FolderNode> = {};
        for (const folder of folders as FolderNode[]) folderMap[folder.id] = folder;
        const imageMap: Record<string, ImageEntry> = {};
        for (const image of images as ImageEntry[]) imageMap[image.id] = image;
        return { rootId, folders: folderMap, images: imageMap };
      } catch {
        return null;
      }
    },

    async save(snapshot) {
      try {
        const db = await getDb();
        const tx = db.transaction([FOLDERS, IMAGES, META], 'readwrite');
        await Promise.all([clear(tx.objectStore(FOLDERS)), clear(tx.objectStore(IMAGES))]);
        const folderStore = tx.objectStore(FOLDERS);
        for (const folder of Object.values(snapshot.folders)) folderStore.put(folder);
        const imageStore = tx.objectStore(IMAGES);
        for (const image of Object.values(snapshot.images)) imageStore.put(image);
        tx.objectStore(META).put(snapshot.rootId, 'rootId');
        await txDone(tx);
      } catch {
        // Storage unavailable — falls back to non-persistent behaviour.
      }
    },

    async clear() {
      try {
        const db = await getDb();
        const tx = db.transaction([FOLDERS, IMAGES, META], 'readwrite');
        await Promise.all([clear(tx.objectStore(FOLDERS)), clear(tx.objectStore(IMAGES)), clear(tx.objectStore(META))]);
        await txDone(tx);
      } catch {
        // Ignore.
      }
    },
  };
}
