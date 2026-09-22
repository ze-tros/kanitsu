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

  test('loadOrScan rescans when the library fingerprint changes', async () => {
    const store = await seedStore();
    const index = createMemoryPersistentIndex();
    await loadOrScan(store, index);

    // Simulate an external top-level change: no explicit rescanLibrary call.
    const root = await store.ensureLibraryRoot();
    await store.createFolder(root, 'NewAlbum');

    const snapshot = await loadOrScan(store, index);
    const names = Object.values(snapshot.folders).map((f) => f.name);
    assert.ok(names.includes('NewAlbum'), 'stale cache must be refreshed');
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

describe('RAW 扫描门控(enableRaw)', () => {
  test('默认不收录 RAW;开启后收录且快照记录 rawScan', async () => {
    const store = await seedStore();
    const root = await store.ensureLibraryRoot();
    await store.writeBlob(root, 'IMG_0001.CR2', new Blob(['raw'], { type: 'image/x-raw' }));
    await store.writeBlob(root, 'DSC_0002.ARW', new Blob(['raw'], { type: 'image/x-raw' }));

    const plain = await scanLibrary(store);
    assert.equal(Object.keys(plain.images).length, 1, '未开启时 RAW 不可见');
    assert.notEqual(plain.rawScan, true);

    const enabled = await scanLibrary(store, { enableRaw: true });
    const exts = Object.values(enabled.images).map((img) => img.ext).sort();
    assert.deepEqual(exts, ['arw', 'cr2', 'jpg']);
    assert.equal(enabled.rawScan, true);
  });

  test('enableRaw 开关变化使缓存索引失效并触发重扫', async () => {
    const store = await seedStore();
    const root = await store.ensureLibraryRoot();
    await store.writeBlob(root, 'IMG_0001.CR2', new Blob(['raw'], { type: 'image/x-raw' }));

    const index = createMemoryPersistentIndex();
    const withoutRaw = await loadOrScan(store, index);
    assert.equal(Object.keys(withoutRaw.images).length, 1, '默认扫描只有 jpg');

    const withRaw = await loadOrScan(store, index, { enableRaw: true });
    assert.equal(Object.keys(withRaw.images).length, 2, '开关变化后必须重扫并收录 RAW');

    const again = await loadOrScan(store, index, { enableRaw: true });
    assert.deepEqual(again.images, withRaw.images, '开关一致时缓存仍然命中');
  });

  test('rescanLibrary 透传 enableRaw', async () => {
    const store = await seedStore();
    await store.ensureLibraryRoot();
    const index = createMemoryPersistentIndex();
    const snapshot = await rescanLibrary(store, index, { enableRaw: true });
    assert.equal(snapshot.rawScan, true);
    const cached = await index.load();
    assert.equal(cached?.rawScan, true);
  });
});
