import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLibraryStore } from '../../fs-adapter/src/memory';
import { scanLibrary } from '../src/scan';
import { moveEntries } from '../src/move';
import { undoOrganize } from '../src/organize';
import { resolveFolderRef } from '../src/entry-ops';
import type { LibrarySnapshot } from '../src/types';

async function seedStore(): Promise<MemoryLibraryStore> {
  const store = new MemoryLibraryStore();
  const root = await store.ensureLibraryRoot();
  const packA = await store.createFolder(root, 'PackA');
  const sub = await store.createFolder(packA, 'Sub');
  await store.writeBlob(packA, 'one.jpg', new Blob(['one'], { type: 'image/jpeg' }));
  await store.writeBlob(packA, 'dup.jpg', new Blob(['a-dup'], { type: 'image/jpeg' }));
  await store.writeBlob(sub, 'deep.jpg', new Blob(['deep'], { type: 'image/jpeg' }));
  const target = await store.createFolder(root, 'Target');
  await store.writeBlob(target, 'dup.jpg', new Blob(['t-dup'], { type: 'image/jpeg' }));
  await store.createFolder(target, 'Sub');
  return store;
}

const imageId = (s: LibrarySnapshot, rel: string): string => {
  const image = Object.values(s.images).find((item) => item.relPath === rel);
  assert.ok(image, `快照应包含图片：${rel}`);
  return image.id;
};
const folderId = (s: LibrarySnapshot, rel: string): string => {
  const folder = Object.values(s.folders).find((item) => item.relPath === rel);
  assert.ok(folder, `快照应包含图包：${rel}`);
  return folder.id;
};
const rels = (s: LibrarySnapshot): string[] => Object.values(s.images).map((i) => i.relPath).sort();

describe('moveEntries', () => {
  test('moves images, renaming on collision, and the move is undoable', async () => {
    const store = await seedStore();
    const before = await scanLibrary(store);
    const result = await moveEntries(store, before, 'Target', {
      imageIds: [imageId(before, 'PackA/one.jpg'), imageId(before, 'PackA/dup.jpg')],
      folderIds: [],
    });
    assert.equal(result.movedImages, 2);
    assert.deepEqual(result.failures, []);
    const after = await scanLibrary(store);
    assert.deepEqual(rels(after), ['PackA/Sub/deep.jpg', 'Target/dup (2).jpg', 'Target/dup.jpg', 'Target/one.jpg']);

    const undo = await undoOrganize(store, result.manifest);
    assert.equal(undo.undone, 2);
    assert.deepEqual(rels(await scanLibrary(store)), ['PackA/Sub/deep.jpg', 'PackA/dup.jpg', 'PackA/one.jpg', 'Target/dup.jpg']);
  });

  test('moves whole folders; skips same-name targets and moves into own subtree', async () => {
    const store = await seedStore();
    const before = await scanLibrary(store);
    const conflict = await moveEntries(store, before, 'Target', { imageIds: [], folderIds: [folderId(before, 'PackA/Sub')] });
    assert.equal(conflict.movedFolders, 0);
    assert.deepEqual(conflict.failures.map((f) => f.reason), ['target-exists']);

    const inside = await moveEntries(store, before, 'PackA/Sub', { imageIds: [], folderIds: [folderId(before, 'PackA')] });
    assert.deepEqual(inside.failures.map((f) => f.reason), ['invalid-target']);

    const ok = await moveEntries(store, before, 'Target', {
      // 图片与其所在图包同时选中：图片随图包一起移动，不单独处理。
      imageIds: [imageId(before, 'PackA/one.jpg')],
      folderIds: [folderId(before, 'PackA')],
    });
    assert.equal(ok.movedFolders, 1);
    assert.equal(ok.movedImages, 0);
    assert.deepEqual(rels(await scanLibrary(store)), ['Target/PackA/Sub/deep.jpg', 'Target/PackA/dup.jpg', 'Target/PackA/one.jpg', 'Target/dup.jpg']);
  });

  test('images already in the target folder are left alone', async () => {
    const store = await seedStore();
    const before = await scanLibrary(store);
    const result = await moveEntries(store, before, 'Target', { imageIds: [imageId(before, 'Target/dup.jpg')], folderIds: [] });
    assert.equal(result.movedImages, 0);
    assert.equal(result.manifest.actions.length, 0);
  });

  test('image colliding with a same-name directory in the target is renamed, directory intact', async () => {
    const store = await seedStore();
    // 目标目录里已有一个【目录】叫 photo.jpg。
    const root = await store.ensureLibraryRoot();
    const packB = await store.createFolder(root, 'PackB');
    await store.writeBlob(packB, 'photo.jpg', new Blob(['photo'], { type: 'image/jpeg' }));
    const target = await store.createFolder(root, 'Target');
    const photoDir = await store.createFolder(target, 'photo.jpg');
    await store.writeBlob(photoDir, 'inner.jpg', new Blob(['inner'], { type: 'image/jpeg' }));

    const before = await scanLibrary(store);
    const result = await moveEntries(store, before, 'Target', {
      imageIds: [imageId(before, 'PackB/photo.jpg')],
      folderIds: [],
    });
    assert.equal(result.movedImages, 1);
    assert.deepEqual(result.failures, []);

    const after = await scanLibrary(store);
    const paths = Object.values(after.images).map((i) => i.relPath).sort();
    assert.ok(paths.includes('Target/photo (2).jpg'), '图片改名避开同名目录');
    assert.ok(paths.includes('Target/photo.jpg/inner.jpg'), '同名目录及其内容原样保留');
  });

  test('folder colliding with a same-name file in the target reports target-exists', async () => {
    const store = await seedStore();
    const root = await store.ensureLibraryRoot();
    // 目标目录里已有一个【文件】叫 Blocked，而 PackA 下有同名图包。
    const target = await store.createFolder(root, 'Target');
    await store.writeBlob(target, 'Blocked', new Blob(['file'], { type: 'image/jpeg' }));
    const blocked = await store.createFolder(root, 'BlockedPackSrc');
    await store.createFolder(blocked, 'Blocked');
    await store.writeBlob(await store.createFolder(blocked, 'Blocked'), 'x.jpg', new Blob(['x'], { type: 'image/jpeg' }));

    const before = await scanLibrary(store);
    const result = await moveEntries(store, before, 'Target', {
      imageIds: [],
      folderIds: [folderId(before, 'BlockedPackSrc/Blocked')],
    });
    assert.equal(result.movedFolders, 0);
    assert.deepEqual(result.failures.map((f) => f.reason), ['target-exists']);

    // 'Blocked' 无扩展名不进快照，直接列目标目录验证文件未被覆盖。
    const targetRef = await resolveFolderRef(store, 'Target');
    assert.ok(targetRef);
    const names: string[] = [];
    for await (const child of store.listChildren(targetRef)) names.push(`${child.kind}:${child.name}`);
    assert.ok(names.includes('file:Blocked'), '同名文件未被覆盖');

    const after = await scanLibrary(store);
    assert.ok(
      Object.values(after.images).some((i) => i.relPath === 'BlockedPackSrc/Blocked/x.jpg'),
      '源图包未被移动',
    );
  });
});
