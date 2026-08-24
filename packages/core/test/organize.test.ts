import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLibraryStore } from '../../fs-adapter/src/memory';
import { scanLibrary, imagesOf } from '../src/scan';
import { organizeByFolder } from '../../organizer/src/organizer';
import { applyOrganize, undoOrganize, type OrganizeManifest } from '../src/organize';

async function seedStore(): Promise<MemoryLibraryStore> {
  const store = new MemoryLibraryStore();
  const root = await store.ensureLibraryRoot();

  const manga = await store.createFolder(root, 'MangaA');
  const vol1 = await store.createFolder(manga, 'Vol.01');
  await store.writeBlob(vol1, 'Attack_on_Titan_Vol.01_p001.jpg', new Blob(['a'], { type: 'image/svg+xml' }));
  await store.writeBlob(vol1, 'Attack_on_Titan_Vol.01_p002.jpg', new Blob(['b'], { type: 'image/svg+xml' }));

  const travel = await store.createFolder(root, 'Travel');
  await store.writeBlob(travel, '2024-03-05_trip_001.jpg', new Blob(['c'], { type: 'image/svg+xml' }));

  // Low-confidence file that should be left in place (no explicit structure).
  await store.writeBlob(manga, 'pic001.jpg', new Blob(['d'], { type: 'image/svg+xml' }));

  return store;
}

describe('applyOrganize / undoOrganize', () => {
  test('moves files into the organized tree and undoes them', async () => {
    const store = await seedStore();
    let snapshot = await scanLibrary(store);

    const bindings = organizeByFolder(imagesOf(snapshot, snapshot.rootId));

    const result = await applyOrganize(store, snapshot, '', bindings);

    // The two volume files + the date file are high-confidence and should move;
    // pic001.jpg falls to '未分类' (0.2) and must stay in place.
    assert.equal(result.appliedCount, 3, 'three structured files moved');
    assert.equal(result.conflicts.length, 0, 'no conflicts on clean seed');
    assert.equal(result.skippedLowConfidenceCount, 1, 'pic001.jpg skipped');
    assert.equal(result.manifest.actions.length, 3);

    // Re-scan and verify the new tree.
    snapshot = await scanLibrary(store);
    const paths = Object.values(snapshot.images).map((i) => i.relPath).sort();
    assert.ok(paths.includes('Attack_on_Titan/Vol.01/p001.jpg'), 'p001.jpg organized');
    assert.ok(paths.includes('Attack_on_Titan/Vol.01/p002.jpg'), 'p002.jpg organized');
    assert.ok(paths.includes('2024/03/05/trip_001.jpg'), 'date-organized file moved');
    assert.ok(paths.includes('MangaA/pic001.jpg'), 'low-confidence file left in place');

    // Undo restores the original layout.
    const undone = await undoOrganize(store, result.manifest);
    assert.equal(undone.errors.length, 0);
    assert.equal(undone.undone, 3);

    snapshot = await scanLibrary(store);
    const restored = Object.values(snapshot.images).map((i) => i.relPath).sort();
    assert.ok(restored.includes('MangaA/Vol.01/Attack_on_Titan_Vol.01_p001.jpg'), 'p001.jpg restored');
    assert.ok(restored.includes('MangaA/Vol.01/Attack_on_Titan_Vol.01_p002.jpg'), 'p002.jpg restored');
    assert.ok(restored.includes('Travel/2024-03-05_trip_001.jpg'), 'date file restored');
  });

  test('reports a target-exists conflict in skip mode', async () => {
    const store = await seedStore();
    const snapshot = await scanLibrary(store);

    // Pre-occupy the exact target of the first volume file, relative to container 'MangaA'.
    const root = await store.ensureLibraryRoot();
    const attack = await store.createFolder(root, 'MangaA');
    const series = await store.createFolder(attack, 'Attack_on_Titan');
    const vol01 = await store.createFolder(series, 'Vol.01');
    await store.writeBlob(vol01, 'p001.jpg', new Blob(['occupied'], { type: 'image/svg+xml' }));

    const mangaNode = Object.values(snapshot.folders).find((f) => f.relPath === 'MangaA')!;
    const bindings = organizeByFolder(imagesOf(snapshot, mangaNode.id));

    const result = await applyOrganize(store, snapshot, 'MangaA', bindings);
    assert.ok(result.conflicts.some((c) => c.reason === 'target-exists'), 'conflict reported');
  });

  test('empty manifest undoes cleanly', async () => {
    const manifest: OrganizeManifest = { id: 'x', createdAt: 0, containerRelPath: '', actions: [] };
    const store = new MemoryLibraryStore();
    const res = await undoOrganize(store, manifest);
    assert.equal(res.undone, 0);
    assert.equal(res.errors.length, 0);
  });
});
