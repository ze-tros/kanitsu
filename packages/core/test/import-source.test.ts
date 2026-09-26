import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLibraryStore } from '../../fs-adapter/src/memory';
import { scanLibrary } from '../src/scan';
import { importFolder } from '../src/import';
import type {
  FileRef,
  FolderRef,
  FsEntry,
  ImportSourcePicker,
  NativeImportProgress,
  NativeImportResult,
} from '../../fs-adapter/src/types';

/** 拖入导入得到的源目录：由 resolveDroppedFolder 解析，而非 pickFolder。 */
const dropped: FolderRef = { id: 'drop', name: '拖入相册', kind: 'folder' };

class DropPicker implements ImportSourcePicker {
  pickCalls = 0;
  released = false;

  async pickFolder(): Promise<FolderRef> {
    this.pickCalls++;
    throw new Error('pickFolder should not be called when options.source is provided');
  }

  async *listChildren(folder: FolderRef): AsyncGenerator<FsEntry, void, void> {
    if (folder.id === 'drop') {
      yield { id: 'drop/a.jpg', name: 'a.jpg', kind: 'file' } as FileRef;
      yield { id: 'drop/readme.txt', name: 'readme.txt', kind: 'file' } as FileRef;
      yield { id: 'drop/sub', name: 'sub', kind: 'folder' } as FolderRef;
    } else if (folder.id === 'drop/sub') {
      yield { id: 'drop/sub/b.png', name: 'b.png', kind: 'file' } as FileRef;
    }
  }

  async readBlob(): Promise<Blob> {
    return new Blob(['x'], { type: 'image/jpeg' });
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

describe('importFolder with options.source', () => {
  test('uses the provided source instead of pickFolder (fallback copy path)', async () => {
    const picker = new DropPicker();
    const store = new MemoryLibraryStore();

    const task = await importFolder(picker, store, { source: dropped });

    assert.equal(picker.pickCalls, 0);
    assert.equal(task.status, 'done');
    assert.equal(task.sourceFolderName, '拖入相册');
    assert.equal(task.targetTopFolder, '拖入相册');
    assert.equal(task.scannedFileCount, 3);
    assert.equal(task.copiedImageCount, 2);
    assert.equal(task.skippedCount, 1);
    assert.equal(picker.released, true);

    const snapshot = await scanLibrary(store);
    const images = Object.values(snapshot.images).map((image) => image.relPath).sort();
    assert.deepEqual(images, ['拖入相册/a.jpg', '拖入相册/sub/b.png']);
  });

  test('de-duplicates the top folder name like a picked import', async () => {
    const store = new MemoryLibraryStore();
    const first = await importFolder(new DropPicker(), store, { source: dropped });
    const second = await importFolder(new DropPicker(), store, { source: dropped });
    assert.equal(first.targetTopFolder, '拖入相册');
    assert.notEqual(second.targetTopFolder, first.targetTopFolder);
  });

  test('passes the provided source to the native fast path', async () => {
    class NativeStore extends MemoryLibraryStore {
      received: { source: FolderRef; name: string; token?: string } | null = null;
      async importSourceTree(
        source: FolderRef,
        targetTopName: string,
        onProgress?: (p: NativeImportProgress) => void,
        cancelToken?: string,
      ): Promise<NativeImportResult> {
        this.received = { source, name: targetTopName, token: cancelToken };
        onProgress?.({ scanned: 1, copied: 1, skipped: 0, current: 'a.jpg' });
        return {
          targetTopFolder: targetTopName,
          scannedFileCount: 1,
          copiedImageCount: 1,
          skippedCount: 0,
          skippedFiles: [],
          errors: [],
        };
      }
    }
    const picker = new DropPicker();
    const store = new NativeStore();
    const progress: string[] = [];

    const task = await importFolder(picker, store, {
      source: dropped,
      cancelToken: 'tok-1',
      onProgress: (state) => progress.push(state.status),
    });

    assert.equal(picker.pickCalls, 0);
    assert.deepEqual(store.received, { source: dropped, name: '拖入相册', token: 'tok-1' });
    assert.equal(task.status, 'done');
    assert.equal(task.copiedImageCount, 1);
    assert.deepEqual(progress, ['scanning', 'copying']);
    assert.equal(picker.released, true);
  });
});
