import assert from 'node:assert/strict';
import test from 'node:test';
import type { FolderNode, ImageEntry, LibrarySnapshot } from '../../core/src/index';
import {
  RECENT_BROWSE_LIMIT,
  browseFolderFor,
  formatRelativeTime,
  pruneImportedAt,
  recordRecentBrowse,
  resolveContinueItems,
} from '../src/browseHistory';

function folder(id: string, parentId: string | null, relPath: string): FolderNode {
  return { id, parentId, name: relPath.split('/').pop() || '图库', relPath, imageCount: 0, directImageCount: 0, childCount: 0 };
}

function image(id: string, folderId: string, relPath: string): ImageEntry {
  return { id, folderId, name: relPath.split('/').pop()!, relPath, ext: 'jpg', size: 1, mtime: 1 };
}

function snapshot(): LibrarySnapshot {
  return {
    rootId: 'root',
    folders: {
      root: folder('root', null, ''),
      a: folder('a', 'root', 'A'),
      a1: folder('a1', 'a', 'A/sub'),
      b: folder('b', 'root', 'B'),
    },
    images: {
      i1: image('i1', 'a', 'A/01.jpg'),
      i2: image('i2', 'a', 'A/02.jpg'),
      i3: image('i3', 'a1', 'A/sub/03.jpg'),
      solo: image('solo', 'b', 'B/only.jpg'),
    },
  };
}

test('同一图包只保留最新位置，且有上限', () => {
  let list = recordRecentBrowse([], 'a', 'i1', 1);
  list = recordRecentBrowse(list, 'b', 'solo', 2);
  list = recordRecentBrowse(list, 'a', 'i2', 3);
  assert.deepEqual(list.map((e) => [e.folderId, e.imageId]), [['a', 'i2'], ['b', 'solo']]);
  for (let i = 0; i < 20; i++) list = recordRecentBrowse(list, `f${i}`, 'x', 10 + i);
  assert.equal(list.length, RECENT_BROWSE_LIMIT);
  assert.equal(list[0]!.folderId, 'f19');
});

test('位置按图片 id 解析，含子目录图片', () => {
  const { items } = resolveContinueItems(snapshot(), [{ folderId: 'a', imageId: 'i3', updatedAt: 1 }]);
  assert.deepEqual(items, [{ folderId: 'a', imageId: 'i3', position: 2, total: 3 }]);
});

test('图片被删、被移出图包、图包消失或只剩一张时丢弃条目', () => {
  const snap = snapshot();
  const { items, pruned } = resolveContinueItems(snap, [
    { folderId: 'a', imageId: 'gone', updatedAt: 1 },
    { folderId: 'a', imageId: 'solo', updatedAt: 1 },
    { folderId: 'zzz', imageId: 'i1', updatedAt: 1 },
    { folderId: 'b', imageId: 'solo', updatedAt: 1 },
    { folderId: 'a', imageId: 'i2', updatedAt: 1 },
  ]);
  assert.deepEqual(items.map((i) => i.imageId), ['i2']);
  assert.equal(pruned.length, 1);
});

test('从根目录（搜索）打开时记在顶层图包上', () => {
  const snap = snapshot();
  assert.equal(browseFolderFor(snap, 'root', 'i3'), 'a');
  assert.equal(browseFolderFor(snap, 'a1', 'i3'), 'a1');
  assert.equal(browseFolderFor(snap, '', 'missing'), null);
});

test('导入时间清理已不存在的图包，无变化返回原对象', () => {
  const snap = snapshot();
  const map = { a: 1, b: 2 };
  assert.equal(pruneImportedAt(snap, map), map);
  assert.deepEqual(pruneImportedAt(snap, { a: 1, gone: 3 }), { a: 1 });
});

test('相对时间', () => {
  const now = new Date(2026, 8, 24, 15, 0).getTime();
  assert.equal(formatRelativeTime(now - 10_000, now), '刚刚');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(formatRelativeTime(now - 3 * 3600_000, now), '3 小时前');
  assert.equal(formatRelativeTime(new Date(2026, 8, 23, 20, 0).getTime(), now), '昨天');
  assert.equal(formatRelativeTime(new Date(2026, 8, 21, 9, 0).getTime(), now), '3 天前');
  assert.equal(formatRelativeTime(new Date(2026, 7, 27, 9, 0).getTime(), now), '8 月 27 日');
});
