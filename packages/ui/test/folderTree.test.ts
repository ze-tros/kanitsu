import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FolderNode, LibrarySnapshot } from '../../core/src/index';
import { buildFolderChildren, collectFolderDescendants, flattenFolderTree, isSubtreeCollapsible } from '../src/desktop/Sidebar';

function makeFolder(id: string, parentId: string | null, name: string, childCount = 0): FolderNode {
  return { id, parentId, name, relPath: name, imageCount: 0, directImageCount: 0, childCount };
}

// root → a(→ a1 → a1x, a2), b
const snapshot: LibrarySnapshot = {
  rootId: 'root',
  images: {},
  folders: {
    root: makeFolder('root', null, '图库', 2),
    a: makeFolder('a', 'root', 'A', 2),
    a1: makeFolder('a1', 'a', 'A1', 1),
    a1x: makeFolder('a1x', 'a1', 'A1x'),
    a2: makeFolder('a2', 'a', 'A2'),
    b: makeFolder('b', 'root', 'B'),
  },
};

describe('collectFolderDescendants', () => {
  const children = buildFolderChildren(snapshot);

  test('收集多层子树内全部后代目录，不含自身', () => {
    assert.deepEqual(new Set(collectFolderDescendants(children, 'a')), new Set(['a1', 'a2', 'a1x']));
  });

  test('叶子目录没有后代', () => {
    assert.deepEqual(collectFolderDescendants(children, 'a2'), []);
  });

  test('从根收集时覆盖全部图包', () => {
    assert.deepEqual(new Set(collectFolderDescendants(children, 'root')), new Set(['a', 'a1', 'a2', 'a1x', 'b']));
  });
});

describe('侧栏「全部展开/收起」的动作判定', () => {
  const children = buildFolderChildren(snapshot);

  // 与 folderMenu 中一致：非根含自身，根只含后代。
  const subtreeIds = (id: string, isLibRoot: boolean) => {
    const descendants = collectFolderDescendants(children, id);
    return isLibRoot ? descendants : [id, ...descendants];
  };

  test('非根目录：自身展开即提供「全部收起」，作用于整棵子树', () => {
    const descendants = collectFolderDescendants(children, 'a');
    assert.equal(isSubtreeCollapsible('a', false, new Set(['a']), descendants), true);
    assert.deepEqual(new Set(subtreeIds('a', false)), new Set(['a', 'a1', 'a2', 'a1x']));
  });

  test('非根目录：自身收起即提供「全部展开」，即使后代仍标记为展开', () => {
    const descendants = collectFolderDescendants(children, 'a');
    assert.equal(isSubtreeCollapsible('a', false, new Set(['a1', 'a2', 'a1x']), descendants), false);
    assert.equal(isSubtreeCollapsible('a', false, new Set(), descendants), false);
  });

  test('根目录：存在已展开的后代即提供「全部收起」，全部收起时提供「全部展开」', () => {
    const descendants = collectFolderDescendants(children, 'root');
    assert.equal(isSubtreeCollapsible('root', true, new Set(['a1']), descendants), true);
    assert.equal(isSubtreeCollapsible('root', true, new Set(['a', 'a1', 'a2', 'a1x', 'b']), descendants), true);
    assert.equal(isSubtreeCollapsible('root', true, new Set(), descendants), false);
  });

  test('根目录的展开范围只含后代（根自身不作为行渲染）', () => {
    assert.deepEqual(new Set(subtreeIds('root', true)), new Set(['a', 'a1', 'a2', 'a1x', 'b']));
  });

  test('全部展开后目录树展示整棵子树', () => {
    const expanded = new Set(subtreeIds('a', false));
    const rows = flattenFolderTree('root', children, (id) => expanded.has(id));
    assert.deepEqual(
      rows.map((row) => `${row.folder.id}@${row.depth}`),
      ['a@0', 'a1@1', 'a1x@2', 'a2@1', 'b@0'],
    );
  });

  test('全部收起后子树行消失，顶层目录保留', () => {
    const rows = flattenFolderTree('root', children, () => false);
    assert.deepEqual(rows.map((row) => row.folder.id), ['a', 'b']);
  });
});
