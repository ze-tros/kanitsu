import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterSettingsTabs,
  hasSettingsTabMatches,
  settingsTabMatches,
  SETTINGS_TABS,
} from '../src/settingsTabs';

test('设置页标签页顺序与桌面端重设计一致', () => {
  assert.deepEqual(
    SETTINGS_TABS.map((tab) => tab.id),
    ['appearance', 'library', 'viewer', 'rules', 'cache', 'diagnostics', 'shortcuts', 'about'],
  );
  assert.deepEqual(
    SETTINGS_TABS.map((tab) => tab.label),
    ['外观', '图库与数据', '查看器', '整理规则', '缓存', '诊断', '快捷键', '关于'],
  );
});

test('设置页正文里的文案都能搜到对应标签页', () => {
  // 回归：旧实现只和一份硬编码整串比对，页面上的这些文案一律搜不到。
  // 注意 activeTab 必须取「另一个」标签页，否则 filterSettingsTabs 会无条件保留它，
  // 断言就退化成永真（测不出关键词是否真的命中）。
  for (const [query, expected] of [
    ['主题色', 'appearance'],
    ['浅色', 'appearance'],
    ['跟随系统', 'appearance'],
    ['朱砂', 'appearance'],
    ['图库占用', 'library'],
    ['数据目录', 'library'],
    // 旧称仍能双向命中关键词「保存位置」，改名后不打断老用户的搜索习惯。
    ['图包保存位置', 'library'],
    ['保存路径', 'library'],
    ['RAW 观感', 'viewer'],
    ['相机直出', 'viewer'],
    ['显影', 'viewer'],
    ['智能整理', 'rules'],
    ['内置规则', 'rules'],
    ['运行诊断', 'diagnostics'],
    ['缓存管理', 'cache'],
    // 比关键词更长的查询（双向匹配）：面板里的真实文案也要能搜到。
    ['累计掉帧', 'diagnostics'],
    ['平均帧间隔', 'diagnostics'],
    ['队列积压', 'diagnostics'],
    ['日志等级', 'diagnostics'],
    ['后台预取', 'diagnostics'],
    ['主进程缓存条目', 'cache'],
    ['缩略图缓存命中率', 'cache'],
    ['清除缓存', 'cache'],
    ['未命中', 'cache'],
    ['命令面板', 'shortcuts'],
    ['重命名', 'shortcuts'],
    ['胶片条', 'shortcuts'],
    ['不联网', 'about'],
    ['源文件夹', 'about'],
  ] as const) {
    const otherTab = SETTINGS_TABS.find((tab) => tab.id !== expected)!.id;
    assert.ok(
      filterSettingsTabs(query, otherTab).some((tab) => tab.id === expected),
      `${query} 应命中 ${expected}`,
    );
  }
});

test('空查询保留全部标签页', () => {
  assert.equal(filterSettingsTabs('', 'appearance').length, SETTINGS_TABS.length);
  assert.equal(filterSettingsTabs('   ', 'diagnostics').length, SETTINGS_TABS.length);
  assert.equal(hasSettingsTabMatches(''), true);
});

test('无匹配时保留当前标签页并暴露空状态', () => {
  assert.deepEqual(filterSettingsTabs('zzz', 'diagnostics').map((tab) => tab.id), ['diagnostics']);
  assert.equal(hasSettingsTabMatches('zzz'), false);
});

test('匹配大小写不敏感', () => {
  const diagnostics = SETTINGS_TABS.find((tab) => tab.id === 'diagnostics')!;
  assert.equal(settingsTabMatches(diagnostics, 'FPS'), true);
  assert.deepEqual(
    filterSettingsTabs('FPS', 'appearance').map((tab) => tab.id),
    ['appearance', 'diagnostics'],
  );
});
