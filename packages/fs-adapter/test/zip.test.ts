import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import yauzl from 'yauzl';
import { MemoryLibraryStore } from '../src/memory';

async function seedStore(): Promise<MemoryLibraryStore> {
  const store = new MemoryLibraryStore();
  const root = await store.ensureLibraryRoot();
  const manga = await store.createFolder(root, 'MangaA');
  const vol = await store.createFolder(manga, 'Vol.01');
  await store.writeBlob(vol, 'p001.jpg', new Blob(['aaa'], { type: 'image/jpeg' }));
  await store.writeBlob(vol, 'p002.jpg', new Blob(['bbb'], { type: 'image/svg+xml' }));
  const travel = await store.createFolder(root, 'Travel');
  await store.writeBlob(travel, 'trip.jpg', new Blob(['ccc'], { type: 'image/jpeg' }));
  return store;
}

/** Opens a zip buffer and returns entry names (sorted), using yauzl to validate the structure. */
function listZipEntries(bytes: Uint8Array): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const names: string[] = [];
      zip.on('entry', (entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names.sort()));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('MemoryLibraryStore.zipLibrary', () => {
  test('exports the whole library preserving directory structure', async () => {
    const store = await seedStore();
    const result = await store.zipLibrary('');
    assert.equal(result.kind, 'blob');
    assert.equal(result.totalImages, 3);
    assert.equal(result.exportedCount, 3);

    const bytes = new Uint8Array(await result.blob!.arrayBuffer());
    const names = await listZipEntries(bytes);
    assert.deepEqual(names, ['MangaA/Vol.01/p001.jpg', 'MangaA/Vol.01/p002.jpg', 'Travel/trip.jpg']);
  });

  test('exports a subfolder wrapped under its own name', async () => {
    const store = await seedStore();
    const result = await store.zipLibrary('MangaA');
    assert.equal(result.totalImages, 2);
    const bytes = new Uint8Array(await result.blob!.arrayBuffer());
    const names = await listZipEntries(bytes);
    assert.deepEqual(names, ['MangaA/Vol.01/p001.jpg', 'MangaA/Vol.01/p002.jpg']);
  });

  test('empty library produces a valid (empty) zip', async () => {
    const store = new MemoryLibraryStore();
    await store.ensureLibraryRoot();
    const result = await store.zipLibrary('');
    assert.equal(result.totalImages, 0);
    const bytes = new Uint8Array(await result.blob!.arrayBuffer());
    const names = await listZipEntries(bytes);
    assert.deepEqual(names, []);
  });
});
