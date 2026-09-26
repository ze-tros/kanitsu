import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImageEntry } from '../../core/src/index';
import {
  AUTO_RULE_ID,
  bindingsForRule,
  defaultRuleId,
  planBindings,
  planConflicts,
  previewGroups,
  renameGroup,
  ruleOptions,
} from '../src/organizePlan';

const img = (name: string): ImageEntry => ({ id: name, folderId: 'f', name, relPath: `F/${name}`, ext: 'jpg', size: 1, mtime: 1 });

const images = [
  img('[佐仓] 标题A.jpg'),
  img('[佐仓] 标题B.jpg'),
  img('2025-07-14_0012.jpg'),
  img('cover.png'),
];

test('规则命中数只计可落盘的绑定，自动=全部', () => {
  const plan = planBindings(images, []);
  const options = ruleOptions(plan, []);
  const byId = Object.fromEntries(options.map((o) => [o.id, o.hitCount]));
  assert.equal(byId[AUTO_RULE_ID], 3);
  assert.equal(byId.author, 2);
  assert.equal(byId.date, 1);
  assert.equal(byId.pixiv, 0);
});

test('选单条规则时其余图片保持原位', () => {
  const plan = planBindings(images, []);
  assert.deepEqual(bindingsForRule(plan, 'author').map((b) => b.imageId), ['[佐仓] 标题A.jpg', '[佐仓] 标题B.jpg']);
  assert.equal(bindingsForRule(plan, AUTO_RULE_ID).length, 3);
});

test('自定义规则优先并以名称作为规则 id', () => {
  const rules = [{ id: 'r1', name: '按作者', pattern: '^\\[(.+?)\\]', target: 'by/$1', confidence: 0.9, enabled: true }];
  const plan = planBindings(images, rules);
  const custom = ruleOptions(plan, rules).find((o) => o.kind === 'custom')!;
  assert.equal(custom.id, '按作者');
  assert.equal(custom.hitCount, 2);
  assert.equal(bindingsForRule(plan, '按作者')[0]!.virtualPath, 'by/佐仓/[佐仓] 标题A.jpg');
});

test('预览按目标目录分组并可重命名', () => {
  const plan = bindingsForRule(planBindings(images, []), AUTO_RULE_ID);
  const groups = previewGroups(plan);
  assert.deepEqual(groups.map((g) => [g.dir, g.bindings.length]), [['2025/07/14', 1], ['佐仓', 2]]);
  const renamed = renameGroup(plan, '佐仓', ' 樱 / 佐仓 ');
  assert.deepEqual(previewGroups(renamed).map((g) => g.dir), ['2025/07/14', '樱/佐仓']);
  assert.equal(renameGroup(plan, '佐仓', '../x')[0]!.virtualPath, plan[0]!.virtualPath);
});

test('默认规则取命中最多的单条规则，全无命中时为自动', () => {
  const plan = planBindings(images, []);
  assert.equal(defaultRuleId(ruleOptions(plan, [])), 'author');
  const none = planBindings([img('cover.png')], []);
  assert.equal(defaultRuleId(ruleOptions(none, [])), AUTO_RULE_ID);
});

test('冲突预估：已有目录记为合并，同名文件与本次重复路径记为冲突，已在原位的不算', () => {
  const plan = bindingsForRule(planBindings([img('[佐仓] 标题A.jpg'), img('[佐仓] 标题B.jpg')], []), 'author');
  const groups = previewGroups(plan);
  assert.equal(groups.length, 1);
  const dir = groups[0]!.dir;
  const target = (id: string) => plan.find((b) => b.imageId === id)!.virtualPath.split('/').pop()!;
  const existing = new Map([[dir, { names: new Set([target('[佐仓] 标题A.jpg')]) }]]);
  const result = planConflicts(groups, (d) => existing.get(d), (id) => `F/${id}`, 'F');
  assert.deepEqual([...result.mergeDirs], [dir]);
  assert.deepEqual([...result.conflictIds], ['[佐仓] 标题A.jpg']);

  // 同一路径两张图：后到的冲突。
  const dup = [{ ...plan[0]!, imageId: 'x' }, { ...plan[0]!, imageId: 'y' }];
  const dupResult = planConflicts(previewGroups(dup), () => undefined, () => undefined, 'F');
  assert.deepEqual([...dupResult.conflictIds], ['y']);
  assert.equal(dupResult.mergeDirs.size, 0);

  // 已经在目标位置：不算冲突。
  const inPlace = planConflicts(groups, (d) => existing.get(d), (id) => `F/${plan.find((b) => b.imageId === id)!.virtualPath}`, 'F');
  assert.equal(inPlace.conflictIds.size, 0);
});
