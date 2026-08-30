import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLibraryStore } from '../../fs-adapter/src/memory';
import { scanLibrary } from '../src/scan';
import { importFolder } from '../src/import';
import type { FileRef, FolderRef, FsEntry, ImportSourcePicker } from '../../fs-adapter/src/types';

const root: FolderRef = { id: 'src', name: '测试相册', kind: 'folder' };

class MockPicker implements ImportSourcePicker {
  released = false;

  constructor(
    private readonly childrenByFolder: (folder: FolderRef) => AsyncGenerator<FsEntry, void, void>,
    private readonly readFile: (file: FileRef) => Promise<Blob> = async () => new Blob(['x'], { type: 'image/jpeg' }),
  ) {}

  async pickFolder(): Promise<FolderRef> {
    return root;
  }

  async *listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void> {
    yield* this.childrenByFolder(folder);
  }

  async readBlob(file: FileRef): Promise<Blob> {
    return this.readFile(file);
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

describe('importFolder', () => {
  test('records per-file read failures and keeps successful copies', async () => {
    const picker = new MockPicker(async function* (folder) {
      if (folder.id !== 'src') return;
      yield { id: 'src/good.jpg', name: 'good.jpg', kind: 'file' } as FileRef;
      yield { id: 'src/legacy.jpe', name: 'legacy.jpe', kind: 'file' } as FileRef;
      yield { id: 'src/bad.jpg', name: 'bad.jpg', kind: 'file' } as FileRef;
    }, async (file) => {
      if (file.name === 'bad.jpg') throw new Error('read failed');
      return new Blob(['ok'], { type: 'image/jpeg' });
    });
    const store = new MemoryLibraryStore();

    const task = await importFolder(picker, store);

     assert.equal(task.copiedImageCount, 2);
    assert.equal(task.errors.length, 1);
    assert.match(task.errors[0]!, /bad.jpg/);
    assert.equal(picker.released, true);

    const snapshot = await scanLibrary(store);
    const images = Object.values(snapshot.images);
     assert.equal(images.length, 2);
     assert.ok(images.some((image) => image.name === 'good.jpg'));
     assert.ok(images.some((image) => image.name === 'legacy.jpe'));
  });

  test('cleans up the created top folder when traversal fails', async () => {
    const picker = new MockPicker(async function* (folder) {
      if (folder.id === 'src') {
        yield { id: 'src/sub', name: 'sub', kind: 'folder' } as FolderRef;
        return;
      }
      throw new Error('traversal failed');
    });
    const store = new MemoryLibraryStore();

    await assert.rejects(() => importFolder(picker, store), /traversal failed/);
    assert.equal(picker.released, true);

    const snapshot = await scanLibrary(store);
    assert.equal(Object.values(snapshot.folders).filter((f) => f.relPath !== '').length, 0);
  });
});
