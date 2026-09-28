import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blurredPathRemap,
  folderPrefixRemap,
  pruneBlurredPaths,
  relPathPairsFromActions,
  remapBlurredPaths,
} from '../src/libraryPrefs';

test('remapBlurredPaths 迁移命中项并保留其余项', () => {
  const prev = new Set(['Pack/a.jpg', 'Pack/b.jpg', 'Other/c.jpg']);
  const next = remapBlurredPaths(prev, (p) => (p === 'Pack/a.jpg' ? 'Pack/renamed.jpg' : null));
  assert.deepEqual([...next].sort(), ['Other/c.jpg', 'Pack/b.jpg', 'Pack/renamed.jpg']);
  // 旧路径标记被替换而非新增：集合里不再有旧路径。
  assert.ok(!next.has('Pack/a.jpg'));
});

test('remapBlurredPaths 无变化时返回原集合（同一引用，避免无谓落盘）', () => {
  const prev = new Set(['a.jpg']);
  assert.equal(remapBlurredPaths(prev, () => null), prev);
  assert.equal(remapBlurredPaths(prev, (p) => p), prev);
});

test('folderPrefixRemap 按最长前缀重写目录子树', () => {
  const remap = folderPrefixRemap(
    new Map([
      ['Pack', 'NewPack'],
      ['Pack/Sub', 'Other/Sub'],
    ]),
  );
  assert.equal(remap('Pack'), 'NewPack');
  assert.equal(remap('Pack/a.jpg'), 'NewPack/a.jpg');
  assert.equal(remap('Pack/Sub/deep/b.jpg'), 'Other/Sub/deep/b.jpg');
  // 前缀必须是路径段边界：'PackX' 不属于 'Pack' 子树。
  assert.equal(remap('PackX/c.jpg'), null);
  assert.equal(remap('Elsewhere/d.jpg'), null);
});

test('blurredPathRemap 整合精确改写与前缀改写', () => {
  const remap = blurredPathRemap(new Map([['A/old.jpg', 'B/new.jpg']]), new Map([['Old', 'New']]));
  assert.equal(remap('A/old.jpg'), 'B/new.jpg');
  assert.equal(remap('Old/x.jpg'), 'New/x.jpg');
  assert.equal(remap('untouched.jpg'), null);
  // 未提供前缀映射时精确映射仍生效。
  const exactOnly = blurredPathRemap(new Map([['a.jpg', 'b.jpg']]));
  assert.equal(exactOnly('a.jpg'), 'b.jpg');
});

test('relPathPairsFromActions 构造旧→新路径映射（根目录与重名改写）', () => {
  const pairs = relPathPairsFromActions([
    { fromRelPath: '', fromName: 'a.jpg', toRelPath: 'Pack', toName: 'a.jpg' },
    { fromRelPath: 'Pack', fromName: 'b.jpg', toRelPath: 'Pack', toName: 'b (2).jpg' },
    { fromRelPath: 'Pack', fromName: 'same.jpg', toRelPath: 'Pack', toName: 'same.jpg' },
  ]);
  assert.equal(pairs.size, 2);
  assert.equal(pairs.get('a.jpg'), 'Pack/a.jpg');
  assert.equal(pairs.get('Pack/b.jpg'), 'Pack/b (2).jpg');
  assert.ok(!pairs.has('Pack/same.jpg'));
});

test('pruneBlurredPaths 丢弃失效标记', () => {
  const prev = new Set(['gone.jpg', 'alive.jpg']);
  const next = pruneBlurredPaths(prev, (p) => p !== 'gone.jpg');
  assert.deepEqual([...next], ['alive.jpg']);
  assert.equal(pruneBlurredPaths(prev, () => true), prev);
});
