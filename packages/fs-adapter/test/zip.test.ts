import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import yauzl from 'yauzl';
import { buildZip, crc32, type ZipEntry } from '../src/zip';
import { MemoryLibraryStore } from '../src/memory';

async function seedStore(): Promise<MemoryLibraryStore> {
  const store = new MemoryLibraryStore();
  const root = await store.ensureLibraryRoot();
  const manga = await store.createFolder(root, 'MangaA');
  const vol = await store.createFolder(manga, 'Vol.01');
  await store.writeBlob(vol, 'p001.jpg', new Blob(['aaa'], { type: 'image/jpeg' }));
  await store.writeBlob(vol, 'p002.jpg', new Blob(['bbb'], { type: 'image/svg+xml' }));
  const travel = await store.createFolder(root, 'Travel');
  await store.writeBlob(travel, 'trip.jpg', new Blob(['ccc'], { type: 'image/jpeg' }));
  return store;
}

interface ReadEntry {
  name: string;
  data?: Buffer;
}

/** Opens a zip buffer and returns entries, optionally reading their data. */
function readZip(bytes: Uint8Array, withData = false): Promise<ReadEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries: ReadEntry[] = [];
      zip.on('entry', (entry) => {
        if (!withData) {
          entries.push({ name: entry.fileName });
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (err2, stream) => {
          if (err2) return reject(err2);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            entries.push({ name: entry.fileName, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('MemoryLibraryStore.zipLibrary', () => {
  test('exports the whole library preserving structure with an index.json', async () => {
    const store = await seedStore();
    const result = await store.zipLibrary('');
    assert.equal(result.kind, 'blob');
    assert.equal(result.totalImages, 3);
    assert.equal(result.exportedCount, 3);

    const bytes = new Uint8Array(await result.blob!.arrayBuffer());
    const entries = await readZip(bytes, true);

    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['MangaA/Vol.01/p001.jpg', 'MangaA/Vol.01/p002.jpg', 'Travel/trip.jpg', 'index.json']);

    const index = JSON.parse(entries.find((e) => e.name === 'index.json')!.data!.toString());
    assert.equal(index.version, 1);
    assert.equal(index.root, '');
    assert.equal(index.images.length, 3);
    assert.equal(index.folders.length, 3);
    assert.ok(index.folders.some((f: { relPath: string }) => f.relPath === 'MangaA/Vol.01'));
  });

  test('exports a subfolder wrapped under its own name + index.json', async () => {
    const store = await seedStore();
    const result = await store.zipLibrary('MangaA');
    assert.equal(result.totalImages, 2);
    const bytes = new Uint8Array(await result.blob!.arrayBuffer());
    const entries = await readZip(bytes, true);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['MangaA/Vol.01/p001.jpg', 'MangaA/Vol.01/p002.jpg', 'index.json']);

    const index = JSON.parse(entries.find((e) => e.name === 'index.json')!.data!.toString());
    assert.equal(index.root, 'MangaA');
    assert.equal(index.images.length, 2);
  });

  test('empty library produces a zip with an empty index.json', async () => {
    const store = new MemoryLibraryStore();
    await store.ensureLibraryRoot();
    const result = await store.zipLibrary('');
    assert.equal(result.totalImages, 0);
    const bytes = new Uint8Array(await result.blob!.arrayBuffer());
    const entries = await readZip(bytes, true);
    assert.deepEqual(entries.map((e) => e.name), ['index.json']);
    const index = JSON.parse(entries[0]!.data!.toString());
    assert.equal(index.images.length, 0);
    assert.deepEqual(index.folders, []);
  });
});

function u32le(bytes: Uint8Array, pos: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(pos, true);
}

describe('buildZip ZIP64', () => {
  test('条目数 > 65535 时写 ZIP64 EOCD，yauzl 能读出全部条目', async () => {
    const entries: ZipEntry[] = [];
    for (let i = 0; i < 70000; i++) {
      entries.push({ name: `f${i}.jpg`, data: new Uint8Array([0x61 + (i % 26)]) });
    }
    const bytes = buildZip(entries);
    assert.equal(crc32(new Uint8Array([0x61])), 0xe8b7be43, 'CRC 基准值');

    // EOCD 位于文件尾：条目数字段应为 0xFFFF 哨兵。
    const eocdAt = bytes.length - 22;
    assert.equal(u32le(bytes, eocdAt), 0x06054b50);
    assert.equal(new DataView(bytes.buffer, eocdAt, 22).getUint16(8, true), 0xffff);

    // Locator 指向 ZIP64 EOCD，记录里是真实条目数。
    const locatorAt = eocdAt - 20;
    assert.equal(u32le(bytes, locatorAt), 0x07064b50);
    const eocd64Offset = Number(new DataView(bytes.buffer, locatorAt, 20).getBigUint64(8, true));
    assert.equal(u32le(bytes, eocd64Offset), 0x06064b50);
    const eocd64Entries = Number(new DataView(bytes.buffer, eocd64Offset, 56).getBigUint64(32, true));
    assert.equal(eocd64Entries, 70000);

    // 端到端：标准解压器读出的条目数与内容一致。
    const read = await readZip(bytes);
    assert.equal(read.length, 70000);
    assert.equal(read[0]!.name, 'f0.jpg');
    assert.equal(read[69999]!.name, 'f69999.jpg');
  });

  test('小归档不写 ZIP64 结构（保持与传统读法兼容）', async () => {
    const bytes = buildZip([{ name: 'a.jpg', data: new Uint8Array([1]) }]);
    const eocdAt = bytes.length - 22;
    assert.equal(u32le(bytes, eocdAt), 0x06054b50);
    assert.equal(new DataView(bytes.buffer, eocdAt, 22).getUint16(8, true), 1);
    const locatorAt = eocdAt - 20;
    assert.notEqual(u32le(bytes, locatorAt), 0x07064b50, '不应有 ZIP64 locator');
  });
});
