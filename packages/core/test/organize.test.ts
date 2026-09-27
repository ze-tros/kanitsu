import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLibraryStore } from '../../fs-adapter/src/memory';
import { scanLibrary, imagesOf } from '../src/scan';
import { applyCustomRule, organizeByFolder, parseImageName, validateCustomRulePattern } from '../../organizer/src/organizer';
import { applyOrganize, undoOrganize, type OrganizeManifest } from '../src/organize';
import { resolveFolderRef } from '../src/entry-ops';

describe('organizer naming rules', () => {
  test('groups pixiv-style ids by work id', () => {
    const paged = parseImageName('001_131950002_p0.jpg');
    assert.equal(paged.virtualPath, '131950002/001_131950002_p0.jpg');
    assert.equal(paged.confidence, 0.9);

    const plain = parseImageName('012_131879670.gif');
    assert.equal(plain.virtualPath, '131879670/012_131879670.gif');
    assert.equal(plain.confidence, 0.85);
  });

  test('custom rules run before built-ins and group by capture group', () => {
    const rule = {
      id: 'test-prefix',
      name: '三位前缀分组',
      pattern: '^(\\d{3})_',
      target: '$1',
      confidence: 0.88,
      enabled: true,
    };

    const direct = applyCustomRule('042_123456789_p0.jpg', rule);
    assert.equal(direct?.virtualPath, '042/042_123456789_p0.jpg');
    assert.equal(direct?.confidence, 0.88);

    const viaParser = parseImageName('042_123456789_p0.jpg', [rule]);
    assert.equal(viaParser.virtualPath, '042/042_123456789_p0.jpg');
    // parsed.rule 返回规则 id（唯一）：重名规则不会在命中统计与选中行为上串台。
    assert.equal(viaParser.rule, 'test-prefix');
  });

  test('invalid custom regex is ignored', () => {
    const rule = {
      id: 'bad',
      name: '坏规则',
      pattern: '(',
      target: '$1',
      confidence: 0.9,
      enabled: true,
    };
    assert.equal(applyCustomRule('001_131950002_p0.jpg', rule), null);
  });
});

async function seedStore(): Promise<MemoryLibraryStore> {
  const store = new MemoryLibraryStore();
  const root = await store.ensureLibraryRoot();

  const manga = await store.createFolder(root, 'MangaA');
  const vol1 = await store.createFolder(manga, 'Vol.01');
  await store.writeBlob(vol1, 'Attack_on_Titan_Vol.01_p001.jpg', new Blob(['a'], { type: 'image/svg+xml' }));
  await store.writeBlob(vol1, 'Attack_on_Titan_Vol.01_p002.jpg', new Blob(['b'], { type: 'image/svg+xml' }));

  const travel = await store.createFolder(root, 'Travel');
  await store.writeBlob(travel, '2024-03-05_trip_001.jpg', new Blob(['c'], { type: 'image/svg+xml' }));

  // Low-confidence file that should be left in place (no explicit structure).
  await store.writeBlob(manga, 'pic001.jpg', new Blob(['d'], { type: 'image/svg+xml' }));

  return store;
}

describe('applyOrganize / undoOrganize', () => {
  test('moves files into the organized tree and undoes them', async () => {
    const store = await seedStore();
    let snapshot = await scanLibrary(store);

    const bindings = organizeByFolder(imagesOf(snapshot, snapshot.rootId));

    const result = await applyOrganize(store, snapshot, '', bindings);

    // The two volume files + the date file are high-confidence and should move;
    // pic001.jpg falls to '未分类' (0.2) and must stay in place.
    assert.equal(result.appliedCount, 3, 'three structured files moved');
    assert.equal(result.conflicts.length, 0, 'no conflicts on clean seed');
    assert.equal(result.skippedLowConfidenceCount, 1, 'pic001.jpg skipped');
    assert.equal(result.manifest.actions.length, 3);

    // Re-scan and verify the new tree.
    snapshot = await scanLibrary(store);
    const paths = Object.values(snapshot.images).map((i) => i.relPath).sort();
    assert.ok(paths.includes('Attack_on_Titan/Vol.01/p001.jpg'), 'p001.jpg organized');
    assert.ok(paths.includes('Attack_on_Titan/Vol.01/p002.jpg'), 'p002.jpg organized');
    assert.ok(paths.includes('2024/03/05/trip_001.jpg'), 'date-organized file moved');
    assert.ok(paths.includes('MangaA/pic001.jpg'), 'low-confidence file left in place');

    // Undo restores the original layout.
    const undone = await undoOrganize(store, result.manifest);
    assert.equal(undone.errors.length, 0);
    assert.equal(undone.undone, 3);

    snapshot = await scanLibrary(store);
    const restored = Object.values(snapshot.images).map((i) => i.relPath).sort();
    assert.ok(restored.includes('MangaA/Vol.01/Attack_on_Titan_Vol.01_p001.jpg'), 'p001.jpg restored');
    assert.ok(restored.includes('MangaA/Vol.01/Attack_on_Titan_Vol.01_p002.jpg'), 'p002.jpg restored');
    assert.ok(restored.includes('Travel/2024-03-05_trip_001.jpg'), 'date file restored');
  });

  test('reports a target-exists conflict in skip mode', async () => {
    const store = await seedStore();
    const snapshot = await scanLibrary(store);

    // Pre-occupy the exact target of the first volume file, relative to container 'MangaA'.
    const root = await store.ensureLibraryRoot();
    const attack = await store.createFolder(root, 'MangaA');
    const series = await store.createFolder(attack, 'Attack_on_Titan');
    const vol01 = await store.createFolder(series, 'Vol.01');
    await store.writeBlob(vol01, 'p001.jpg', new Blob(['occupied'], { type: 'image/svg+xml' }));

    const mangaNode = Object.values(snapshot.folders).find((f) => f.relPath === 'MangaA')!;
    const bindings = organizeByFolder(imagesOf(snapshot, mangaNode.id));

    const result = await applyOrganize(store, snapshot, 'MangaA', bindings);
    assert.ok(result.conflicts.some((c) => c.reason === 'target-exists'), 'conflict reported');
  });

  test('undo skips a file when the original path is already occupied', async () => {
    const store = await seedStore();
    let snapshot = await scanLibrary(store);

    const bindings = organizeByFolder(imagesOf(snapshot, snapshot.rootId));
    const result = await applyOrganize(store, snapshot, '', bindings);
    assert.equal(result.appliedCount, 3);

    // Re-create the original p001 path with a newer file after organizing.
    const root = await store.ensureLibraryRoot();
    const manga = await store.createFolder(root, 'MangaA');
    const vol = await store.createFolder(manga, 'Vol.01');
    await store.writeBlob(vol, 'Attack_on_Titan_Vol.01_p001.jpg', new Blob(['new'], { type: 'image/svg+xml' }));

    const undone = await undoOrganize(store, result.manifest);
    assert.equal(undone.undone, 2, 'p001 must be skipped, the other two actions should restore');
    assert.equal(undone.errors.length, 1);
    assert.match(undone.errors[0]!, /目标已存在/);

    snapshot = await scanLibrary(store);
    const relPaths = Object.values(snapshot.images).map((image) => image.relPath);
    assert.ok(
      relPaths.includes('MangaA/Vol.01/Attack_on_Titan_Vol.01_p001.jpg'),
      'the newly written file at the original path must survive',
    );
  });

  test('empty manifest undoes cleanly', async () => {
    const manifest: OrganizeManifest = { id: 'x', createdAt: 0, containerRelPath: '', actions: [] };
    const store = new MemoryLibraryStore();
    const res = await undoOrganize(store, manifest);
    assert.equal(res.undone, 0);
    assert.equal(res.errors.length, 0);
  });
});

describe('目标位置已有同名目录 / 同名文件（三端语义对齐）', () => {
  test('目标目录里已有同名【目录】时按 target-exists 处理，目录子树不被破坏', async () => {
    const store = new MemoryLibraryStore();
    const root = await store.ensureLibraryRoot();
    const pack = await store.createFolder(root, 'Pack');
    await store.writeBlob(pack, 'x.jpg', new Blob(['x'], { type: 'image/svg+xml' }));
    // 关键种子：目标位置是一个【目录】叫 a.jpg，里面还有文件（旧实现会静默覆盖整棵子树）。
    const dir = await store.createFolder(pack, 'a.jpg');
    await store.writeBlob(dir, 'inner.jpg', new Blob(['inner'], { type: 'image/svg+xml' }));

    const snapshot = await scanLibrary(store);
    const image = Object.values(snapshot.images).find((i) => i.relPath === 'Pack/x.jpg')!;
    const result = await applyOrganize(store, snapshot, 'Pack', [
      { imageId: image.id, virtualPath: 'a.jpg', confidence: 0.9, materialized: false },
    ]);

    assert.equal(result.appliedCount, 0);
    assert.deepEqual(result.conflicts.map((c) => c.reason), ['target-exists']);

    // 目录与内部文件原封不动。
    const after = await scanLibrary(store);
    assert.ok(
      Object.values(after.images).some((i) => i.relPath === 'Pack/a.jpg/inner.jpg'),
      '同名目录的子文件必须原样保留',
    );
    assert.ok(Object.values(after.images).some((i) => i.relPath === 'Pack/x.jpg'), '源文件未被移动');
  });

  test('rename 模式为同名【目录】追加序号而不是移进去', async () => {
    const store = new MemoryLibraryStore();
    const root = await store.ensureLibraryRoot();
    const pack = await store.createFolder(root, 'Pack');
    await store.writeBlob(pack, 'x.jpg', new Blob(['x'], { type: 'image/svg+xml' }));
    const dir = await store.createFolder(pack, 'a.jpg');
    await store.writeBlob(dir, 'inner.jpg', new Blob(['inner'], { type: 'image/svg+xml' }));

    const snapshot = await scanLibrary(store);
    const image = Object.values(snapshot.images).find((i) => i.relPath === 'Pack/x.jpg')!;
    const result = await applyOrganize(
      store,
      snapshot,
      'Pack',
      [{ imageId: image.id, virtualPath: 'a.jpg', confidence: 0.9, materialized: false }],
      { conflict: 'rename' },
    );

    assert.equal(result.appliedCount, 1);
    const after = await scanLibrary(store);
    const paths = Object.values(after.images).map((i) => i.relPath).sort();
    assert.deepEqual(paths, ['Pack/a (2).jpg', 'Pack/a.jpg/inner.jpg']);
  });

  test('目标路径中间段被同名【文件】占用时按 target-exists 处理，不再创建目录', async () => {
    const store = new MemoryLibraryStore();
    const root = await store.ensureLibraryRoot();
    const pack = await store.createFolder(root, 'Pack');
    await store.writeBlob(pack, 'x.jpg', new Blob(['x'], { type: 'image/svg+xml' }));
    // 关键种子：'2024' 是文件不是目录（真实平台 createFolder 会 ENOTDIR/EEXIST）。
    await store.writeBlob(pack, '2024', new Blob(['blocker'], { type: 'image/svg+xml' }));

    const snapshot = await scanLibrary(store);
    const image = Object.values(snapshot.images).find((i) => i.relPath === 'Pack/x.jpg')!;
    const result = await applyOrganize(store, snapshot, 'Pack', [
      { imageId: image.id, virtualPath: '2024/03/x.jpg', confidence: 0.9, materialized: false },
    ]);

    assert.equal(result.appliedCount, 0);
    assert.deepEqual(result.conflicts.map((c) => c.reason), ['target-exists']);
    const after = await scanLibrary(store);
    assert.ok(Object.values(after.images).some((i) => i.relPath === 'Pack/x.jpg'), '源文件未被移动');
    assert.ok(
      !Object.values(after.folders).some((f) => f.relPath === 'Pack/2024' || f.relPath === 'Pack/2024/03'),
      '不得把同名文件当目录穿越/改建',
    );
  });

  test('含 .. 的绑定被 canonicalizeRelPath 拒绝并记为 move-failed', async () => {
    const store = new MemoryLibraryStore();
    const root = await store.ensureLibraryRoot();
    const pack = await store.createFolder(root, 'Pack');
    await store.writeBlob(pack, 'x.jpg', new Blob(['x'], { type: 'image/svg+xml' }));

    const snapshot = await scanLibrary(store);
    const image = Object.values(snapshot.images).find((i) => i.relPath === 'Pack/x.jpg')!;
    const result = await applyOrganize(store, snapshot, 'Pack', [
      { imageId: image.id, virtualPath: '../escape.jpg', confidence: 0.9, materialized: false },
    ]);

    assert.equal(result.appliedCount, 0);
    assert.deepEqual(result.conflicts.map((c) => c.reason), ['move-failed']);
    const after = await scanLibrary(store);
    assert.ok(
      !Object.values(after.images).some((i) => i.relPath.includes('escape')),
      '文件不得逃出整理容器',
    );
  });

  test('多级 ..（a/../../b.jpg）同样被拒绝；绝对路径样式的绑定被约束在容器内', async () => {
    const store = new MemoryLibraryStore();
    const root = await store.ensureLibraryRoot();
    const pack = await store.createFolder(root, 'Pack');
    await store.writeBlob(pack, 'x.jpg', new Blob(['x'], { type: 'image/svg+xml' }));
    await store.writeBlob(pack, 'y.jpg', new Blob(['y'], { type: 'image/svg+xml' }));

    const snapshot = await scanLibrary(store);
    const byName = (name: string) => Object.values(snapshot.images).find((i) => i.name === name)!;
    const result = await applyOrganize(store, snapshot, 'Pack', [
      { imageId: byName('x.jpg').id, virtualPath: 'a/../../b.jpg', confidence: 0.9, materialized: false },
      { imageId: byName('y.jpg').id, virtualPath: '/abs/y.jpg', confidence: 0.9, materialized: false },
    ]);

    // 多级 .. 逃逸 → move-failed；「/abs/…」不逃逸（前导斜杠被归一为容器相对路径）。
    assert.deepEqual(result.conflicts.map((c) => c.reason), ['move-failed']);
    assert.equal(result.appliedCount, 1);
    const after = await scanLibrary(store);
    const rels = Object.values(after.images).map((i) => i.relPath).sort();
    assert.ok(rels.includes('Pack/x.jpg'), '逃逸绑定不得移动文件');
    assert.ok(rels.includes('Pack/abs/y.jpg'), '绝对路径样式的绑定落在容器内');
    assert.ok(!rels.some((rel) => rel.startsWith('abs/') || rel === 'b.jpg'), '不得落到容器外');
  });

  test('移动全部失败时，本次新建的空目标目录被回滚', async () => {
    const store = new MemoryLibraryStore();
    const root = await store.ensureLibraryRoot();
    const pack = await store.createFolder(root, 'Pack');
    await store.writeBlob(pack, 'x.jpg', new Blob(['x'], { type: 'image/svg+xml' }));
    await store.writeBlob(pack, 'y.jpg', new Blob(['y'], { type: 'image/svg+xml' }));

    const snapshot = await scanLibrary(store);
    // 模拟快照过期（源文件在整理前被外部删除）：store.move 全部失败。
    await store.remove({ id: '/Pack/x.jpg', name: 'x.jpg', kind: 'file' });
    await store.remove({ id: '/Pack/y.jpg', name: 'y.jpg', kind: 'file' });

    const byName = (name: string) => Object.values(snapshot.images).find((i) => i.name === name)!;
    const result = await applyOrganize(store, snapshot, 'Pack', [
      { imageId: byName('x.jpg').id, virtualPath: 'fresh/x.jpg', confidence: 0.9, materialized: false },
      { imageId: byName('y.jpg').id, virtualPath: 'fresh/y.jpg', confidence: 0.9, materialized: false },
    ]);

    assert.equal(result.appliedCount, 0);
    assert.equal(result.conflicts.filter((c) => c.reason === 'move-failed').length, 2);
    const after = await scanLibrary(store);
    assert.ok(
      !Object.values(after.folders).some((f) => f.relPath === 'Pack/fresh'),
      '冲突全部失败时新建的空目录不得残留',
    );
  });

  test('undo 不为缺失的目录凭空重建目录树', async () => {
    const store = new MemoryLibraryStore();
    const root = await store.ensureLibraryRoot();
    const pack = await store.createFolder(root, 'Pack');
    await store.writeBlob(pack, 'x.jpg', new Blob(['x'], { type: 'image/svg+xml' }));
    const snapshot = await scanLibrary(store);
    const image = Object.values(snapshot.images).find((i) => i.relPath === 'Pack/x.jpg')!;
    const result = await applyOrganize(store, snapshot, 'Pack', [
      { imageId: image.id, virtualPath: 'new-dir/x.jpg', confidence: 0.9, materialized: false },
    ]);
    assert.equal(result.appliedCount, 1);

    // 用户删掉了整个目标目录树（含移进去的文件），再撤销。
    // 注意：snapshot 里的 folder id 是领域 id（folder:xxx），不是存储层 ref，
    // 删除必须用 resolveFolderRef 解析出真正的存储层条目。
    const newDirRef = await resolveFolderRef(store, 'Pack/new-dir');
    assert.ok(newDirRef, '整理后目标目录存在');
    await store.remove(newDirRef);

    const undone = await undoOrganize(store, result.manifest);
    assert.equal(undone.undone, 0);
    assert.equal(undone.errors.length, 1);
    assert.match(undone.errors[0]!, /无法还原缺失的文件/);
    // 撤销失败后不得留下重建出来的空目录。
    const after = await scanLibrary(store);
    assert.ok(!Object.values(after.folders).some((f) => f.relPath === 'Pack/new-dir'), '不得凭空重建目录');
  });
});

describe('自定义规则的安全校验', () => {
  test('target 展开为空时视为不匹配（回落内置规则），不产出无目录绑定', () => {
    const rule = { id: 't', name: 't', pattern: '^(.+)$', target: '.', confidence: 0.9, enabled: true };
    assert.equal(applyCustomRule('sub.jpg', rule), null);
    const parsed = parseImageName('sub.jpg', [rule]);
    assert.notEqual(parsed.rule, 't', '应回落到内置规则');
    assert.ok(parsed.virtualPath.includes('/'), '兜底结果必须含目录');
  });

  test('灾难性回溯正则被拒绝（静态嵌套量词检测）', () => {
    const safety = validateCustomRulePattern('^(a+)+$');
    assert.equal(safety.ok, false);
    assert.ok(safety.reason);
    // 匹配时同样不生效。
    const rule = { id: 'redos', name: 'redos', pattern: '^(a+)+$', target: '$1', confidence: 0.9, enabled: true };
    assert.equal(applyCustomRule(`${'a'.repeat(24)}b.jpg`, rule), null);
  });

  test('常用合法正则通过校验', () => {
    assert.equal(validateCustomRulePattern('^(\\d{3})_').ok, true);
    assert.equal(validateCustomRulePattern('^(\\d{1,4})_(\\d{5,})_p(\\d+)$').ok, true);
    assert.equal(validateCustomRulePattern('(.*)_(\\d+)').ok, true);
    assert.equal(validateCustomRulePattern('(').ok, false, '语法错误仍被拒绝');
  });
});
