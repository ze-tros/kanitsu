import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DATA_DIR_NOTICE,
  chooseDataDir,
  confirmDataDir,
  fetchDataDir,
  supportsDataDir,
} from '../src/dataDir';

/** node 测试环境没有 window：按渲染端同款形状注入/清理假桥。 */
const g = globalThis as { window?: unknown };
function setBridge(bridge: unknown): void {
  g.window = { kanitsuDesktop: bridge };
}
function clearWindow(): void {
  delete g.window;
}

test('只有桌面端（有 kanitsuDesktop 桥）才支持数据目录', async () => {
  clearWindow();
  assert.equal(supportsDataDir(), false);
  // 读取失败/不支持一律返回 null，由调用方降级（Web 演示 / Android 不渲染设置行）。
  assert.equal(await fetchDataDir(), null);
  assert.equal(await chooseDataDir(), null);
  assert.equal(await confirmDataDir('D:\\x'), null);

  // 有桥但方法缺失（旧版本桥）同样视为不支持。
  setBridge({});
  assert.equal(supportsDataDir(), false);

  setBridge({ getDataDir: async () => '' });
  assert.equal(supportsDataDir(), true);
  clearWindow();
});

test('引导文案把「复制一份」与数据目录内容讲清楚', () => {
  const notice = DATA_DIR_NOTICE.join('');
  assert.match(notice, /复制一份/);
  assert.match(notice, /原始文件夹/);
  // 「删除只作用于副本」是关键承诺，文案改动时不要悄悄丢掉。
  assert.match(notice, /删除/);
  // 缩略图/日志/索引都放这个目录，要说明白，避免用户以为那里只有图包。
  assert.match(notice, /缩略图/);
  assert.match(notice, /日志/);
  // 「系统应用数据目录只剩少量配置」是本特性的核心承诺。
  assert.match(notice, /配置文件/);
});

test('桥接调用失败时降级为可读错误，不抛出', async () => {
  setBridge({
    chooseDataDir: async () => {
      throw new Error('ipc boom');
    },
    confirmDataDir: async () => {
      throw new Error('ipc boom');
    },
  });
  assert.deepEqual(await chooseDataDir(), { canceled: false, error: '打开文件夹选择框失败，请重试。' });
  assert.deepEqual(await confirmDataDir('D:\\x'), { ok: false, error: '设置数据目录失败，请重试。' });
  clearWindow();
});

test('fetchDataDir 把空串视为未设置', async () => {
  setBridge({ getDataDir: async () => '' });
  assert.equal(await fetchDataDir(), null);
  setBridge({ getDataDir: async () => 'D:\\KanitsuData' });
  assert.equal(await fetchDataDir(), 'D:\\KanitsuData');
  setBridge({ getDataDir: async () => undefined });
  assert.equal(await fetchDataDir(), null);
  clearWindow();
});

test('选择被取消时不带错误、不带路径', async () => {
  setBridge({ chooseDataDir: async () => ({ canceled: true }) });
  assert.deepEqual(await chooseDataDir(), { canceled: true });
  setBridge({
    chooseDataDir: async () => ({ canceled: false, error: '该文件夹里已有 3 项内容，且不是 Kanitsu 数据目录，不能选作数据目录。' }),
  });
  const failed = await chooseDataDir();
  assert.equal(failed?.canceled, false);
  assert.match(failed?.error ?? '', /不是 Kanitsu 数据目录/);
  clearWindow();
});
