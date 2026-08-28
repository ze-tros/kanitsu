import assert from 'node:assert/strict';
import test from 'node:test';
import { childrenOf, directImagesOf, imagesOf } from '../src/scan';
import type { FolderNode, ImageEntry, LibrarySnapshot } from '../src/types';

function folder(id: string, parentId: string | null, relPath: string): FolderNode {
  return {
    id,
    parentId,
    name: relPath || 'root',
    relPath,
    imageCount: 0,
    directImageCount: 0,
    childCount: 0,
  };
}

function image(id: string, folderId: string, relPath: string): ImageEntry {
  return {
    id,
    folderId,
    name: relPath.slice(relPath.lastIndexOf('/') + 1),
    relPath,
    ext: 'jpg',
    size: 1,
    mtime: 1,
  };
}

test('snapshot lookup returns sorted recursive images without exposing cached arrays', () => {
  const snapshot: LibrarySnapshot = {
    rootId: 'root',
    folders: {
      root: folder('root', null, ''),
      beta: folder('beta', 'root', 'beta'),
      alpha: folder('alpha', 'root', 'alpha'),
      nested: folder('nested', 'alpha', 'alpha/nested'),
    },
    images: {
      z: image('z', 'root', 'z.jpg'),
      b: image('b', 'beta', 'beta/b.jpg'),
      a2: image('a2', 'alpha', 'alpha/z.jpg'),
      a1: image('a1', 'nested', 'alpha/nested/a.jpg'),
    },
  };

  assert.deepEqual(imagesOf(snapshot, 'root').map((item) => item.relPath), [
    'alpha/nested/a.jpg',
    'alpha/z.jpg',
    'beta/b.jpg',
    'z.jpg',
  ]);
  assert.deepEqual(directImagesOf(snapshot, 'alpha').map((item) => item.id), ['a2']);

  childrenOf(snapshot, 'root').reverse();
  imagesOf(snapshot, 'alpha').splice(0);
  assert.deepEqual(childrenOf(snapshot, 'root').map((item) => item.id), ['beta', 'alpha']);
  assert.deepEqual(imagesOf(snapshot, 'alpha').map((item) => item.id), ['a1', 'a2']);
});

test('snapshot records are indexed once and reused across lookup functions', () => {
  let folderEnumerations = 0;
  let imageEnumerations = 0;
  const folders = new Proxy({ root: folder('root', null, '') }, {
    ownKeys(target) {
      folderEnumerations++;
      return Reflect.ownKeys(target);
    },
  });
  const images = new Proxy({ only: image('only', 'root', 'only.jpg') }, {
    ownKeys(target) {
      imageEnumerations++;
      return Reflect.ownKeys(target);
    },
  });
  const snapshot: LibrarySnapshot = { rootId: 'root', folders, images };

  childrenOf(snapshot, 'root');
  directImagesOf(snapshot, 'root');
  imagesOf(snapshot, 'root');
  imagesOf(snapshot, 'root');

  assert.equal(folderEnumerations, 1);
  assert.equal(imageEnumerations, 1);
});
