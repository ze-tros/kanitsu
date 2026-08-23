import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLibraryStore } from '../../fs-adapter/src/memory';
import { scanLibrary } from '../src/scan';
import { deleteLibraryFolder } from '../src/remove';

async function seedStore(): Promise<MemoryLibraryStore> {
  const store = new MemoryLibraryStore();
  const root = await store.ensureLibraryRoot();
  const manga = await store.createFolder(root, 'MangaA');
  const vol = await store.createFolder(manga, 'Vol.01');
  await store.writeBlob(vol, 'a.jpg', new Blob(['a'], { type: 'image/jpeg' }));
  const travel = await store.createFolder(root, 'Travel');
  await store.writeBlob(travel, 'b.jpg', new Blob(['b'], { type: 'image/jpeg' }));
  return store;
}

describe('deleteLibraryFolder', () => {
  test('deletes a folder and all of its descendants', async () => {
    const store = await seedStore();
    const before = await scanLibrary(store);
    assert.ok(Object.values(before.folders).some((f) => f.relPath === 'MangaA/Vol.01'));

    await deleteLibraryFolder(store, 'MangaA');

    const after = await scanLibrary(store);
    const rels = Object.values(after.folders).map((f) => f.relPath);
    assert.ok(!rels.includes('MangaA'), 'MangaA removed');
    assert.ok(!rels.includes('MangaA/Vol.01'), 'descendant removed');
    assert.ok(rels.includes('Travel'), 'sibling kept');
    assert.equal(Object.values(after.images).length, 1, 'only Travel image remains');
  });

  test('rejects deleting the library root', async () => {
    const store = await seedStore();
    await assert.rejects(() => deleteLibraryFolder(store, ''));
  });
});
