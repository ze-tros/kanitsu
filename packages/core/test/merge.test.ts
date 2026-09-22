import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLibraryStore } from '../../fs-adapter/src/memory';
import { scanLibrary } from '../src/scan';
import { mergeIntoNewPack } from '../src/merge';
import { undoOrganize } from '../src/organize';
import type { LibrarySnapshot } from '../src/types';

async function seedStore(): Promise<MemoryLibraryStore> {
  const store = new MemoryLibraryStore();
  const root = await store.ensureLibraryRoot();
  const packA = await store.createFolder(root, 'PackA');
  const sub = await store.createFolder(packA, 'Sub');
  await store.writeBlob(packA, 'one.jpg', new Blob(['one'], { type: 'image/jpeg' }));
  await store.writeBlob(sub, 'dup.jpg', new Blob(['a-dup'], { type: 'image/jpeg' }));
  const packB = await store.createFolder(root, 'PackB');
  const sub2 = await store.createFolder(packB, 'Sub');
  await store.writeBlob(sub2, 'dup.jpg', new Blob(['b-dup'], { type: 'image/jpeg' }));
  await store.writeBlob(packB, 'two.jpg', new Blob(['two'], { type: 'image/jpeg' }));
  const keep = await store.createFolder(root, 'Keep');
  await store.writeBlob(keep, 'three.jpg', new Blob(['three'], { type: 'image/jpeg' }));
  await store.writeBlob(root, 'solo.jpg', new Blob(['solo'], { type: 'image/jpeg' }));
  return store;
}

function imageIdByRel(snapshot: LibrarySnapshot, relPath: string): string {
  const image = Object.values(snapshot.images).find((item) => item.relPath === relPath);
  assert.ok(image, `快照应包含图片：${relPath}`);
  return image.id;
}

function folderIdByRel(snapshot: LibrarySnapshot, relPath: string): string {
  const folder = Object.values(snapshot.folders).find((item) => item.relPath === relPath);
  assert.ok(folder, `快照应包含图包：${relPath}`);
  return folder.id;
}

function namesUnder(snapshot: LibrarySnapshot, prefix: string): string[] {
  return Object.values(snapshot.images)
    .filter((image) => (prefix ? image.relPath.startsWith(`${prefix}/`) : !image.relPath.includes('/')))
    .map((image) => image.name)
    .sort();
}

describe('mergeIntoNewPack', () => {
  test('merges selected images and all descendant images of packs, removes emptied packs', async () => {
    const store = await seedStore();
    const before = await scanLibrary(store);
    const result = await mergeIntoNewPack(store, before, '', 'Merged', {
      imageIds: [imageIdByRel(before, 'solo.jpg')],
      folderIds: [folderIdByRel(before, 'PackA'), folderIdByRel(before, 'PackB')],
    });

    assert.equal(result.movedCount, 5);
    assert.equal(result.conflicts.length, 0);
    assert.deepEqual(result.removedFolderRels, ['PackA', 'PackB']);
    assert.deepEqual(result.keptFolderRels, []);
    assert.equal(result.manifest.actions.length, 5);

    const after = await scanLibrary(store);
    const mergedNames = namesUnder(after, 'Merged');
    // 两个子图包里的同名 dup.jpg 自动改名并存，其余原名并入。
    assert.ok(mergedNames.includes('solo.jpg'));
    assert.ok(mergedNames.includes('one.jpg'));
    assert.ok(mergedNames.includes('two.jpg'));
    const dups = mergedNames.filter((name) => name.startsWith('dup'));
    assert.equal(dups.length, 2);
    assert.ok(dups.includes('dup.jpg'));
    assert.ok(dups.some((name) => /^dup \(\d+\)\.jpg$/.test(name)));

    const rels = Object.values(after.folders).map((folder) => folder.relPath);
    assert.ok(!rels.includes('PackA'));
    assert.ok(!rels.includes('PackA/Sub'));
    assert.ok(!rels.includes('PackB'));
    assert.deepEqual(namesUnder(after, 'Keep'), ['three.jpg'], '未选中的图包不受影响');
  });

  test('dedupes nested/overlapping selections and only deletes top-level packs', async () => {
    const store = await seedStore();
    const before = await scanLibrary(store);
    const result = await mergeIntoNewPack(store, before, '', 'Merged', {
      // 图片与其所在的图包同时选中、子图包与父图包同时选中：都只算一次。
      imageIds: [imageIdByRel(before, 'PackA/one.jpg')],
      folderIds: [folderIdByRel(before, 'PackA'), folderIdByRel(before, 'PackA/Sub')],
    });

    assert.equal(result.movedCount, 2, '重叠选择的图片只移动一次');
    assert.deepEqual(result.removedFolderRels, ['PackA'], '嵌套子图包随祖先一起删除');
    assert.deepEqual(namesUnder(await scanLibrary(store), 'Merged'), ['dup.jpg', 'one.jpg']);
  });

  test('keeps a pack when some of its images fail to move', async () => {
    const store = await seedStore();
    const before = await scanLibrary(store);
    // 模拟文件在快照之外被移走：合并时移动失败，原图包必须保留。
    await store.remove({ id: '/PackA/one.jpg', name: 'one.jpg', kind: 'file' });

    const result = await mergeIntoNewPack(store, before, '', 'Merged', {
      imageIds: [],
      folderIds: [folderIdByRel(before, 'PackA'), folderIdByRel(before, 'PackB')],
    });

    assert.equal(result.movedCount, 3);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]?.reason, 'move-failed');
    assert.deepEqual(result.keptFolderRels, ['PackA']);
    assert.deepEqual(result.removedFolderRels, ['PackB']);

    const after = await scanLibrary(store);
    assert.ok(Object.values(after.folders).some((folder) => folder.relPath === 'PackA'), '仍有图片的图包保留');
  });

  test('undo restores merged images and recreates deleted pack folders', async () => {
    const store = await seedStore();
    const before = await scanLibrary(store);
    const result = await mergeIntoNewPack(store, before, '', 'Merged', {
      imageIds: [imageIdByRel(before, 'solo.jpg')],
      folderIds: [folderIdByRel(before, 'PackA')],
    });

    const undo = await undoOrganize(store, result.manifest);
    assert.equal(undo.errors.length, 0);
    assert.equal(undo.undone, 3);

    const after = await scanLibrary(store);
    const rels = Object.values(after.images).map((image) => image.relPath).sort();
    assert.deepEqual(rels, ['PackA/Sub/dup.jpg', 'PackA/one.jpg', 'PackB/Sub/dup.jpg', 'PackB/two.jpg', 'Keep/three.jpg', 'solo.jpg'].sort());
  });

  test('rejects duplicate pack names and empty selections', async () => {
    const store = await seedStore();
    const before = await scanLibrary(store);
    await assert.rejects(
      () =>
        mergeIntoNewPack(store, before, '', 'Keep', {
          imageIds: [imageIdByRel(before, 'solo.jpg')],
          folderIds: [],
        }),
      /同名/,
    );
    await assert.rejects(
      () => mergeIntoNewPack(store, before, '', 'Merged', { imageIds: [], folderIds: [] }),
      /未选择/,
    );
  });
});
