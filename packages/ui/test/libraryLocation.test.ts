import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIBRARY_COPY_NOTICE,
  describeLocationChange,
  shouldPromptLibraryLocation,
  type LibraryLocationInfo,
} from '../src/libraryLocation';

const baseInfo: LibraryLocationInfo = {
  path: 'C:\\Users\\demo\\AppData\\Roaming\\Kanitsu\\albums',
  isDefault: true,
  confirmed: false,
  exists: true,
};

test('只有桌面端拿到未确认的位置才弹首次运行引导', () => {
  // 位置读取失败（Web 演示 / Android / IPC 出错）一律不弹。
  assert.equal(shouldPromptLibraryLocation(null), false);
  assert.equal(shouldPromptLibraryLocation({ ...baseInfo, confirmed: false }), true);
  assert.equal(shouldPromptLibraryLocation({ ...baseInfo, confirmed: true }), false);
});

test('复制一份的处理方式在引导里讲清楚', () => {
  const notice = LIBRARY_COPY_NOTICE.join('');
  assert.match(notice, /复制一份/);
  assert.match(notice, /原始文件夹/);
  // 「删除只作用于副本」是关键承诺，文案改动时不要悄悄丢掉。
  assert.match(notice, /删除/);
});

test('取消不产生提示，其余分支都有可读结果', () => {
  // 用户在系统选择框里点了取消：调用方据此不打提示。
  assert.equal(describeLocationChange({ canceled: true }), '');
  assert.equal(describeLocationChange(null), '当前环境不支持自定义图包保存位置。');
});

test('失败时带出主进程给出的原因', () => {
  const text = describeLocationChange({ canceled: false, error: '该文件夹里已有 3 项内容，且不是 Kanitsu 图库。' });
  assert.match(text, /^未更改保存位置：/);
  assert.match(text, /不是 Kanitsu 图库/);
});

test('搬移与仅切换两种成功结果文案不同', () => {
  const moved = describeLocationChange({
    canceled: false,
    path: 'D:\\图包',
    isDefault: false,
    moved: true,
    movedCount: 7,
  });
  assert.match(moved, /D:\\图包/);
  assert.match(moved, /搬移了 7 项/);
  assert.doesNotMatch(moved, /留在原位置/);

  // 目标已有同名项而跳过时要说清楚，避免用户以为全部搬完了。
  const partial = describeLocationChange({
    canceled: false,
    path: 'D:\\图包',
    isDefault: false,
    moved: true,
    movedCount: 7,
    skippedCount: 2,
  });
  assert.match(partial, /另有 2 项因目标已存在同名项留在原位置/);

  const switched = describeLocationChange({ canceled: false, path: 'D:\\图包', isDefault: false, moved: false });
  assert.match(switched, /原位置的内容保持不变/);
  assert.doesNotMatch(switched, /搬移/);

  // 恢复默认：不把默认路径泄露成裸路径以外的措辞。
  const reset = describeLocationChange({ canceled: false, path: 'C:\\Albums', isDefault: true });
  assert.match(reset, /默认位置/);
});
