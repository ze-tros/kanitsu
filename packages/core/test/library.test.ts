import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLibraryStore } from '../../fs-adapter/src/memory';
import { scanLibrary } from '../src/scan';
import { loadOrScan, rescanLibrary, createMemoryPersistentIndex } from '../src/library';

async function seedStore(): Promise<MemoryLibraryStore> {
  const store = new MemoryLibraryStore();
  const root = await store.ensureLibraryRoot();
  const manga = await store.createFolder(root, 'MangaA');
  await store.writeBlob(manga, 'a.jpg', new Blob(['a'], { type: 'image/jpeg' }));
  return store;
}

describe('loadOrScan / rescanLibrary', () => {
  test('loadOrScan scans and persists when the cache is empty', async () => {
    const store = await seedStore();
    const index = createMemoryPersistentIndex();
    const snapshot = await loadOrScan(store, index);
    const cached = await index.load();
    assert.ok(cached, 'index persisted');
    assert.equal(Object.keys(cached.images).length, 1);
    assert.equal(snapshot.rootId, cached.rootId);
  });

  test('loadOrScan returns the cached snapshot when present (no re-scan)', async () => {
    const store = await seedStore();
    const index = createMemoryPersistentIndex();
    const first = await scanLibrary(store);
    await index.save(first);
    const second = await loadOrScan(store, index);
    assert.equal(second.rootId, first.rootId);
    assert.deepEqual(second.images, first.images);
  });

  test('rescanLibrary updates the cache after a mutation', async () => {
    const store = await seedStore();
    const index = createMemoryPersistentIndex();
    await loadOrScan(store, index);
    const root = await store.ensureLibraryRoot();
    await store.createFolder(root, 'NewAlbum');
    await rescanLibrary(store, index);
    const cached = await index.load();
    assert.ok(cached, 'cache updated');
    const names = Object.values(cached.folders).map((f) => f.name);
    assert.ok(names.includes('NewAlbum'), 'new folder appears in index');
  });

  test('clear empties the cache', async () => {
    const store = await seedStore();
    const index = createMemoryPersistentIndex();
    await loadOrScan(store, index);
    await index.clear();
    assert.equal(await index.load(), null);
  });
});
