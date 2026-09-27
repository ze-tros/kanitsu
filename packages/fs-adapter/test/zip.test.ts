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

describe('buildZip 字段与编码', () => {
  test('UTF-8 文件名置 bit 11 标志并可完整往返', async () => {
    const name = '相册/东京旅拍 📷/p001.jpg';
    const bytes = buildZip([{ name, data: new Uint8Array([1, 2, 3]) }]);
    // 本地文件头：bit 11（0x0800）必须置位，文件名按 UTF-8 字节数写入。
    const nameBytes = new TextEncoder().encode(name);
    assert.equal(new DataView(bytes.buffer, 0, 30).getUint16(6, true) & 0x0800, 0x0800, 'UTF-8 标志');
    assert.equal(new DataView(bytes.buffer, 0, 30).getUint16(26, true), nameBytes.length);
    const read = await readZip(bytes, true);
    assert.equal(read.length, 1);
    assert.equal(read[0]!.name, name);
    assert.deepEqual(read[0]!.data, Buffer.from([1, 2, 3]));
  });

  test('EOCD 的中央目录偏移与大小等于实际字节位置', async () => {
    const entries: ZipEntry[] = [
      { name: 'a.jpg', data: new Uint8Array([1]) },
      { name: 'b/b.jpg', data: new Uint8Array([2, 2]) },
    ];
    const bytes = buildZip(entries);
    const eocdAt = bytes.length - 22;
    const cdSize = u32le(bytes, eocdAt + 12);
    const cdOffset = u32le(bytes, eocdAt + 16);
    assert.equal(u32le(bytes, cdOffset), 0x02014b50, '中央目录起始处是第一个 central header');
    // 中央目录连续覆盖到 EOCD 之前。
    assert.equal(cdOffset + cdSize, eocdAt);
    const read = await readZip(bytes, true);
    assert.deepEqual(
      read.map((e) => e.name).sort(),
      ['a.jpg', 'b/b.jpg'],
      'buildZip 原样输出条目（index.json 由 zipTree 层负责）',
    );
  });

  test('CRC32 与已知值一致（crc32("123456789") = 0xCBF43926）', () => {
    const data = new TextEncoder().encode('123456789');
    assert.equal(crc32(data), 0xcbf43926);
  });
});

describe('MemoryLibraryStore.zipSelection', () => {
  test('只打包所选 relPath，计数与条目集合一致', async () => {
    const store = await seedStore();
    const result = await store.zipSelection(['MangaA/Vol.01/p001.jpg', 'Travel/trip.jpg'], '所选');
    assert.equal(result.kind, 'blob');
    assert.equal(result.totalImages, 2);
    assert.equal(result.exportedCount, 2);

    const bytes = new Uint8Array(await result.blob!.arrayBuffer());
    const entries = await readZip(bytes, true);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['MangaA/Vol.01/p001.jpg', 'Travel/trip.jpg', 'index.json']);
    const index = JSON.parse(entries.find((e) => e.name === 'index.json')!.data!.toString());
    assert.equal(index.images.length, 2);
    assert.deepEqual(
      index.images.map((i: { relPath: string }) => i.relPath).sort(),
      ['MangaA/Vol.01/p001.jpg', 'Travel/trip.jpg'],
    );
  });
});
