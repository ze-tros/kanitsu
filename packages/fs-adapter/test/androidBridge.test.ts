import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AndroidLibraryStore, b64ToBytes, bytesToB64, initAndroidBridge } from '../src/android';
import type { LibraryStore } from '../src/types';
import { createAndroidPluginMock, pseudoRandomBytes, type NativeEntry } from './helpers/nativeLibrary';
import { setPluginMock } from './helpers/capacitorMock';
// 引入共享契约套件（同捆注册 memory / electron 契约用例），并为 android 运行同一组断言。
import { runLibraryStoreContract } from './contract.test';

// ———————————————————— base64 编解码（android.ts 桥数据面）————————————————————

test('b64ToBytes 解码已知向量与 padding 变体', () => {
  assert.equal(Buffer.from(b64ToBytes('aGVsbG8gd29ybGQ=')).toString('utf8'), 'hello world');
  assert.equal(Buffer.from(b64ToBytes('aGVsbG8gd29ybGQ')).toString('utf8'), 'hello world'); // 无 padding
  assert.deepEqual(b64ToBytes(''), new Uint8Array(0));
  // 0/1/2 mod 3 的长度分别对应 0/1/2 个 '=' padding。
  for (const len of [1, 2, 3, 4]) {
    const bytes = pseudoRandomBytes(len, len);
    const decoded = b64ToBytes(Buffer.from(bytes).toString('base64'));
    assert.ok(Buffer.from(decoded).equals(Buffer.from(bytes)));
  }
});

test('b64ToBytes/bytesToB64 跨分块边界往返', () => {
  // 编码块 32766 字节、解码块 0x8000 字符（= 24576 字节）两侧各取边界前后。
  const sizes = [0, 1, 2, 3, 255, 256, 24575, 24576, 24577, 32765, 32766, 32767, (1 << 20) + 1];
  for (const size of sizes) {
    const bytes = pseudoRandomBytes(size, size + 1);
    const b64 = bytesToB64(bytes);
    assert.equal(b64, Buffer.from(bytes).toString('base64'), `size=${size} 编码应与参照实现一致`);
    const decoded = b64ToBytes(b64);
    assert.ok(Buffer.from(decoded).equals(Buffer.from(bytes)), `size=${size} 往返应一致`);
  }
});

// ———————————————————— AndroidLibraryStore 契约（经真实桥接线 + 插件 mock）——————
// initAndroidBridge 的 bridgePromise 是模块级缓存：整个 bundle 只会通过 mock 的
// registerPlugin 装配一次，所有用例共享同一个插件 mock 实例，用例开头 resetNative()
// 换新树保证隔离。

const pluginMock = createAndroidPluginMock();
setPluginMock(pluginMock);

function freshAndroid(): { store: LibraryStore; dispose(): void } {
  pluginMock.resetNative();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {};
  return {
    store: new AndroidLibraryStore(),
    dispose: () => {
      (globalThis as { window?: unknown }).window = previous;
    },
  };
}

runLibraryStoreContract('android(mock 插件)', freshAndroid);

test('android(mock 插件)：initAndroidBridge 装配的桥可用', async () => {
  const ctx = freshAndroid();
  try {
    const bridge = await initAndroidBridge();
    assert.equal(bridge.platform, 'android');
    const root = await bridge.getLibraryRoot();
    assert.equal(root.id, '/');
  } finally {
    ctx.dispose();
  }
});

test('android(mock 插件)：move 目标已存在时报错（对齐 AlbumLibrary 语义）', async () => {
  const { store, dispose } = freshAndroid();
  try {
    const root = await store.getLibraryRoot();
    const pack = await store.createFolder(root, 'Pack');
    const a = await store.writeBlob(pack, 'a.jpg', new Blob([new Uint8Array([1])]));
    await store.writeBlob(pack, 'b.jpg', new Blob([new Uint8Array([2])]));
    await assert.rejects(() => store.move(a, pack, 'b.jpg'), /目标已存在/);
  } finally {
    dispose();
  }
});

// 类型面自检：writeBlob 返回的 FileRef 携带 size/mtime（桥接线的字段转换）。
test('android(mock 插件)：writeBlob 返回 size/mtime 元数据', async () => {
  const { store, dispose } = freshAndroid();
  try {
    const root = await store.getLibraryRoot();
    const pack = await store.createFolder(root, 'Pack');
    const bytes = pseudoRandomBytes(48, 11);
    const written = await store.writeBlob(pack, 'meta.jpg', new Blob([bytes]));
    const file = written as NativeEntry & { size?: number; mtime?: number };
    assert.equal(file.size, bytes.length);
    assert.ok(typeof file.mtime === 'number');
  } finally {
    dispose();
  }
});
