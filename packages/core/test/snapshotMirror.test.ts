import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSnapshotMirror,
  readSnapshotMirror,
  writeSnapshotMirror,
} from '../src/snapshotMirror';
import type { LibrarySnapshot } from '../src/types';

const MIRROR_KEY = 'kanitsu-snapshot-mirror';

/** Minimal Storage stand-in backed by a Map (Node has no localStorage). */
class MockStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class ThrowingStorage extends MockStorage {
  setItem(key: string, value: string): void {
    if (key === MIRROR_KEY) throw new DOMException('quota exceeded', 'QuotaExceededError');
    super.setItem(key, value);
  }
}

function fakeSnapshot(overrides: Partial<LibrarySnapshot> = {}): LibrarySnapshot {
  return {
    rootId: 'root',
    fingerprint: 'fp-1',
    folders: {
      root: {
        id: 'root',
        parentId: null,
        name: '全部图包',
        relPath: '',
        imageCount: 1,
        directImageCount: 1,
        childCount: 0,
      },
    },
    images: {
      img1: {
        id: 'img1',
        folderId: 'root',
        name: 'a.jpg',
        relPath: 'a.jpg',
        ext: 'jpg',
        size: 10,
        mtime: 1,
        width: 4,
        height: 4,
      },
    },
    ...overrides,
  };
}

describe('snapshotMirror', () => {
  let storage: MockStorage | undefined;

  beforeEach(() => {
    storage = new MockStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    storage = undefined;
  });

  test('write then read round-trips the snapshot', () => {
    const snapshot = fakeSnapshot();
    writeSnapshotMirror(snapshot);
    assert.deepEqual(readSnapshotMirror(), snapshot);
  });

  test('read returns null when nothing was written', () => {
    assert.equal(readSnapshotMirror(), null);
  });

  test('read returns null when storage is unavailable', () => {
    writeSnapshotMirror(fakeSnapshot());
    delete (globalThis as { localStorage?: unknown }).localStorage;
    assert.equal(readSnapshotMirror(), null);
  });

  test('read returns null on corrupted JSON or invalid shape', () => {
    storage!.setItem(MIRROR_KEY, '{not json');
    assert.equal(readSnapshotMirror(), null);

    storage!.setItem(MIRROR_KEY, JSON.stringify({ rootId: 'root' }));
    assert.equal(readSnapshotMirror(), null);
  });

  test('write silently ignores quota errors', () => {
    (globalThis as { localStorage?: unknown }).localStorage = new ThrowingStorage();
    assert.doesNotThrow(() => writeSnapshotMirror(fakeSnapshot()));
    assert.equal(readSnapshotMirror(), null);
  });

  test('clear removes the mirror', () => {
    writeSnapshotMirror(fakeSnapshot());
    clearSnapshotMirror();
    assert.equal(readSnapshotMirror(), null);
  });
});
