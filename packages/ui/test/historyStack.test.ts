import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeOverlayEntries,
  reconcilePop,
  type OverlayLayer,
  type StackEntry,
} from '../src/mobile/historyStack';

const folder = (folderId: string): StackEntry => ({ type: 'folder', folderId });
const overlay = (layer: OverlayLayer): StackEntry => ({ type: 'overlay', layer });

test('关闭 search 层后不再残留幽灵条目（返回键不再被吞）', () => {
  // 「搜索 → 点匹配项进目录」前的栈：search 在顶。目录导航前必须先裁掉它，
  // 否则 search 幽灵条目会吃掉下一次硬件返回。
  const stack = [folder('root'), overlay('search')];
  const { stack: next, closed } = closeOverlayEntries(stack, 'search');
  assert.deepEqual(next, [folder('root')]);
  assert.deepEqual(closed, ['search']);
  const pushed = [...next, folder('album')];
  assert.equal(
    pushed.some((e) => e.type === 'overlay' && e.layer === 'search'),
    false,
  );
});

test('关闭已不存在的层是幂等操作（幽灵 viewer 兜底可反复调用）', () => {
  const stack = [folder('root'), folder('album')];
  const first = closeOverlayEntries(stack, 'viewer');
  assert.equal(first.stack, stack);
  assert.deepEqual(first.closed, ['viewer']);
  const second = closeOverlayEntries(first.stack, 'viewer');
  assert.equal(second.stack, stack);
});

test('关闭 viewer 会连带关闭其上的浮层', () => {
  const stack = [folder('root'), overlay('viewer'), overlay('sheet')];
  const { stack: next, closed } = closeOverlayEntries(stack, 'viewer');
  assert.deepEqual(next, [folder('root')]);
  assert.deepEqual(closed, ['viewer', 'sheet']);
});

test('reconcilePop：快照一致时无动作（主动关闭触发的 back）', () => {
  const stack = [folder('root'), overlay('drawer')];
  assert.deepEqual(reconcilePop(stack, [folder('root'), overlay('drawer')]), {
    changed: false,
    closed: [],
    folderId: null,
  });
});

test('reconcilePop：硬件返回关顶层浮层并保持目录', () => {
  const res = reconcilePop([folder('root'), overlay('search')], [folder('root')]);
  assert.equal(res.changed, true);
  assert.deepEqual(res.closed, ['search']);
  assert.equal(res.folderId, 'root');
});

test('reconcilePop：跨目录多级返回只关差异浮层并落到目标目录', () => {
  const res = reconcilePop(
    [folder('root'), folder('a'), overlay('viewer'), folder('b')],
    [folder('root')],
  );
  assert.equal(res.changed, true);
  assert.deepEqual(res.closed, ['viewer']);
  assert.equal(res.folderId, 'root');
});

test('reconcilePop：幽灵 viewer 条目被返回键关闭时回根目录兜底', () => {
  const res = reconcilePop([overlay('viewer')], []);
  assert.equal(res.changed, true);
  assert.deepEqual(res.closed, ['viewer']);
  assert.equal(res.folderId, null);
});
