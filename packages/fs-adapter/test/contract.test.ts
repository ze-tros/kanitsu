import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryLibraryStore } from '../src/memory';
import type { LibraryStore } from '../src/types';
import { createElectronBridgeMock, pseudoRandomBytes, type NativeEntry } from './helpers/nativeLibrary';
import { ElectronLibraryStore } from '../src/electron';

/**
 * LibraryStore 契约测试：同一组断言在多个适配器上运行，钉住三端必须一致的
 * 数据面语义（types.ts 的契约）。只断言各平台实现真实共享的行为——move 撞名、
 * 覆盖写等语义本就分平台（POSIX rename vs 显式报错）的细节不进契约。
 *
 * 断言覆盖：
 * - 目录结构：createFolder 幂等（同名目录）、同名文件占位时抛错、createTopFolder 落根；
 * - 数据往返：writeBlob → listChildren(size) → readBlob 字节一致；
 * - readSlice：types.ts 唯一成文的数据面契约「越过文件尾返回更短片段」；
 * - move：同目录改名 + 跨目录移动，列子项反映新位置，旧位置移除；
 * - remove：文件与空目录移除后不再出现；
 * - fingerprint：树未变时稳定，顶层增删后变化。
 */

interface ContractContext {
  store: LibraryStore;
  /** 清理全局副作用（如 window 上注入的桥）。 */
  dispose?(): void;
}

export function runLibraryStoreContract(label: string, make: () => Promise<ContractContext> | ContractContext): void {
  test(`${label}：目录结构与 createFolder 语义`, async () => {
    const { store, dispose } = await make();
    try {
      const root = await store.getLibraryRoot();
      const pack = await store.createFolder(root, 'Pack');
      assert.equal(pack.kind, 'folder');
      assert.equal(pack.name, 'Pack');

      // 同名目录已存在：幂等返回（三端 getOrCreate/mkdirs 语义一致）。
      const again = await store.createFolder(root, 'Pack');
      assert.equal(again.name, 'Pack');

      // 同名文件占位：必须抛错（ENOTDIR/EEXIST），不能静默当目录用。
      await store.writeBlob(root, 'clash', new Blob([new Uint8Array([1])]));
      await assert.rejects(() => store.createFolder(root, 'clash'));

      const entries = await collect(store.listChildren(root));
      const folder = entries.find((e) => e.name === 'Pack');
      assert.ok(folder && folder.kind === 'folder', '根目录应列出 Pack 目录');
      const file = entries.find((e) => e.name === 'clash');
      assert.ok(file && file.kind === 'file', '根目录应列出 clash 文件');
    } finally {
      dispose?.();
    }
  });

  test(`${label}：createTopFolder 落在图库根`, async () => {
    const { store, dispose } = await make();
    try {
      const root = await store.getLibraryRoot();
      await store.createTopFolder('NewPack');
      const entries = await collect(store.listChildren(root));
      const created = entries.find((e) => e.name === 'NewPack');
      assert.ok(created && created.kind === 'folder', '根目录应出现 NewPack');
    } finally {
      dispose?.();
    }
  });

  test(`${label}：writeBlob / readBlob 字节往返`, async () => {
    const { store, dispose } = await make();
    try {
      const root = await store.getLibraryRoot();
      const pack = await store.createFolder(root, 'Pack');
      const bytes = pseudoRandomBytes(1 << 20, 0x1234); // 1MB：跨越多轮分块编解码
      const written = await store.writeBlob(pack, 'p001.jpg', new Blob([bytes]));
      assert.equal(written.kind, 'file');
      assert.equal(written.name, 'p001.jpg');

      const entries = await collect(store.listChildren(pack));
      const file = entries.find((e) => e.name === 'p001.jpg');
      assert.ok(file && file.kind === 'file');
      assert.equal(file.size, bytes.length, 'listChildren 应携带与内容一致的 size');

      const blob = await store.readBlob(written);
      assert.equal(blob.size, bytes.length);
      assert.ok(bytesEqual(new Uint8Array(await blob.arrayBuffer()), bytes), 'readBlob 内容应与写入字节一致');
    } finally {
      dispose?.();
    }
  });

  test(`${label}：readSlice 窗口语义（越尾截短、越界为空）`, async () => {
    const { store, dispose } = await make();
    try {
      const root = await store.getLibraryRoot();
      const pack = await store.createFolder(root, 'Pack');
      const bytes = pseudoRandomBytes(1024, 0xbeef);
      const file = await store.writeBlob(pack, 'raw.jpg', new Blob([bytes]));

      const mid = await store.readSlice(file, 100, 10);
      assert.ok(bytesEqual(mid, bytes.subarray(100, 110)), '[100,110) 应精确命中');

      const tail = await store.readSlice(file, bytes.length - 5, 100);
      assert.equal(tail.length, 5, '越过文件尾应返回更短片段');

      const past = await store.readSlice(file, bytes.length + 10, 10);
      assert.equal(past.length, 0, '偏移越过文件尾应返回空');

      const zero = await store.readSlice(file, 0, 0);
      assert.equal(zero.length, 0, 'length=0 应返回空');
    } finally {
      dispose?.();
    }
  });

  test(`${label}：move 改名与跨目录`, async () => {
    const { store, dispose } = await make();
    try {
      const root = await store.getLibraryRoot();
      const packA = await store.createFolder(root, 'PackA');
      const packB = await store.createFolder(root, 'PackB');
      const bytes = pseudoRandomBytes(64, 7);
      const file = await store.writeBlob(packA, 'p001.jpg', new Blob([bytes]));

      // 同目录改名。
      const renamed = await store.move(file, packA, 'p002.jpg');
      assert.equal(renamed.kind, 'file');
      assert.equal(renamed.name, 'p002.jpg');
      let entries = await collect(store.listChildren(packA));
      assert.ok(entries.some((e) => e.name === 'p002.jpg'));
      assert.ok(!entries.some((e) => e.name === 'p001.jpg'), '改名后旧名不应残留');

      // 跨目录移动（保持名字）。
      const moved = await store.move(renamed, packB);
      assert.equal(moved.name, 'p002.jpg');
      entries = await collect(store.listChildren(packA));
      assert.equal(entries.filter((e) => e.kind === 'file').length, 0, '源目录应不再有该文件');
      entries = await collect(store.listChildren(packB));
      assert.ok(entries.some((e) => e.name === 'p002.jpg'));

      // 移动后内容仍可读。
      const blob = await store.readBlob(moved);
      assert.ok(bytesEqual(new Uint8Array(await blob.arrayBuffer()), bytes));
    } finally {
      dispose?.();
    }
  });

  test(`${label}：remove 移除文件与空目录`, async () => {
    const { store, dispose } = await make();
    try {
      const root = await store.getLibraryRoot();
      const pack = await store.createFolder(root, 'Pack');
      const file = await store.writeBlob(pack, 'p001.jpg', new Blob([new Uint8Array([1, 2, 3])]));
      await store.remove(file);
      let entries = await collect(store.listChildren(pack));
      assert.equal(entries.length, 0, '文件移除后目录应为空');

      const empty = await store.createFolder(root, 'Empty');
      await store.remove(empty);
      entries = await collect(store.listChildren(root));
      assert.ok(!entries.some((e) => e.name === 'Empty'), '空目录移除后不应再出现');
    } finally {
      dispose?.();
    }
  });

  test(`${label}：fingerprint 未变时稳定、顶层变化后更新`, async () => {
    const { store, dispose } = await make();
    try {
      const fp1 = await store.getLibraryFingerprint();
      const fp2 = await store.getLibraryFingerprint();
      assert.equal(fp1, fp2, '树未变时 fingerprint 应稳定');

      await store.createTopFolder('Another');
      const fp3 = await store.getLibraryFingerprint();
      assert.notEqual(fp1, fp3, '顶层新增目录后 fingerprint 应变化');
    } finally {
      dispose?.();
    }
  });

  test(`${label}：readThumbnail 返回图片 Blob`, async () => {
    const { store, dispose } = await make();
    try {
      const root = await store.getLibraryRoot();
      const pack = await store.createFolder(root, 'Pack');
      const bytes = pseudoRandomBytes(256, 99);
      const file = await store.writeBlob(pack, 'cover.jpg', new Blob([bytes]));
      const thumb = await store.readThumbnail(file, 512);
      assert.ok(thumb.size > 0);
      assert.ok(bytesEqual(new Uint8Array(await thumb.arrayBuffer()), bytes));
    } finally {
      dispose?.();
    }
  });
}

async function collect<T>(gen: AsyncGenerator<T, void, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ———————————————————— 在三个实现上运行同一组契约 ————————————————————

runLibraryStoreContract('memory', () => ({ store: new MemoryLibraryStore() }));

runLibraryStoreContract('electron(mock 桥)', () => {
  const bridge = createElectronBridgeMock();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { kanitsuDesktop: bridge };
  return {
    store: new ElectronLibraryStore(),
    dispose: () => {
      (globalThis as { window?: unknown }).window = previous;
    },
  };
});

// android 适配器的契约在 androidBridge.test.ts（需要 esbuild alias 替换 @capacitor/core）。

// electron mock 桥特有的类型守卫自检：条目转换不丢 size/mtime。
test('electron(mock 桥)：listChildren 携带 size/mtime 元数据', async () => {
  const bridge = createElectronBridgeMock();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { kanitsuDesktop: bridge };
  try {
    const store = new ElectronLibraryStore();
    const root = await store.getLibraryRoot();
    const pack = await store.createFolder(root, 'Pack');
    const bytes = pseudoRandomBytes(32, 3);
    const written = await store.writeBlob(pack, 'meta.jpg', new Blob([bytes]));
    const file = written as NativeEntry & { size?: number; mtime?: number };
    assert.equal(file.size, bytes.length);
    assert.ok(typeof file.mtime === 'number');
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
});
