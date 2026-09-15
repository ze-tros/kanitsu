import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterSettingsTabs,
  hasSettingsTabMatches,
  settingsTabMatches,
  SETTINGS_TABS,
} from '../src/settingsTabs';

test('设置页正文里的文案都能搜到对应标签页', () => {
  // 回归：旧实现只和一份硬编码整串比对，页面上的这些文案一律搜不到。
  // 注意 activeTab 必须取「另一个」标签页，否则 filterSettingsTabs 会无条件保留它，
  // 断言就退化成永真（测不出关键词是否真的命中）。
  for (const [query, expected] of [
    ['主题色', 'general'],
    ['浅色', 'general'],
    ['跟随系统', 'general'],
    ['图库占用', 'general'],
    ['智能整理', 'organize'],
    ['运行诊断', 'debug'],
    ['缓存管理', 'cache'],
    // 比关键词更长的查询（双向匹配）：面板里的真实文案也要能搜到。
    ['累计掉帧', 'debug'],
    ['主进程缓存条目', 'debug'],
    ['缩略图缓存命中率', 'cache'],
    ['平均帧间隔', 'debug'],
    ['清除缓存', 'cache'],
    ['未命中', 'cache'],
    ['内置规则', 'organize'],
  ] as const) {
    const otherTab = SETTINGS_TABS.find((tab) => tab.id !== expected)!.id;
    assert.ok(
      filterSettingsTabs(query, otherTab).some((tab) => tab.id === expected),
      `${query} 应命中 ${expected}`,
    );
  }
});

test('空查询保留全部标签页', () => {
  assert.equal(filterSettingsTabs('', 'general').length, SETTINGS_TABS.length);
  assert.equal(filterSettingsTabs('   ', 'debug').length, SETTINGS_TABS.length);
  assert.equal(hasSettingsTabMatches(''), true);
});

test('无匹配时保留当前标签页并暴露空状态', () => {
  assert.deepEqual(filterSettingsTabs('zzz', 'debug').map((tab) => tab.id), ['debug']);
  assert.equal(hasSettingsTabMatches('zzz'), false);
});

test('匹配大小写不敏感', () => {
  assert.equal(settingsTabMatches(SETTINGS_TABS[2]!, 'FPS'), true);
  assert.deepEqual(filterSettingsTabs('FPS', 'general').map((tab) => tab.id), ['general', 'debug']);
});
