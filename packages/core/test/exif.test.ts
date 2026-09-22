import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseExif, readExif, type ExifByteSource } from '../src/exif';
import { MemoryLibraryStore } from '../../fs-adapter/src/memory';

// —— 合成 TIFF/EXIF 字节流的小工具（只用于测试）——

type EntryValue = string | number[] | Array<[number, number]>;

interface EntrySpec {
  tag: number;
  /** 2=ASCII 3=SHORT 4=LONG 5=RATIONAL 7=UNDEFINED 10=SRATIONAL */
  type: 2 | 3 | 4 | 5 | 7 | 10;
  value: EntryValue;
}

const TYPE_WIDTH: Record<number, number> = { 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };

function u32le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function asciiBytes(text: string): Uint8Array {
  return new Uint8Array([...text].map((ch) => ch.charCodeAt(0)));
}

function encodeValue(spec: EntrySpec): Uint8Array {
  const out: number[] = [];
  const pushU16 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff);
  const pushU32 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  if (spec.type === 2) {
    for (const ch of spec.value as string) out.push(ch.charCodeAt(0) & 0xff);
    out.push(0);
    return new Uint8Array(out);
  }
  if (spec.type === 5 || spec.type === 10) {
    for (const [n, d] of spec.value as Array<[number, number]>) {
      pushU32(n);
      pushU32(d);
    }
    return new Uint8Array(out);
  }
  for (const v of spec.value as number[]) {
    if (spec.type === 3) pushU16(v);
    else if (spec.type === 4) pushU32(v);
    else out.push(v & 0xff);
  }
  return new Uint8Array(out);
}

function entryCount(spec: EntrySpec): number {
  if (spec.type === 2) return (spec.value as string).length + 1;
  if (spec.type === 5 || spec.type === 10) return (spec.value as Array<[number, number]>).length;
  return (spec.value as number[]).length;
}

/** 合成 TIFF 块：header + IFD0（含子 IFD 指针）+ 各 IFD 的值区。 */
function buildTiff(spec: { ifd0: EntrySpec[]; exif?: EntrySpec[]; gps?: EntrySpec[] }): Uint8Array {
  const subs: Array<{ name: 'Exif' | 'GPS'; entries: EntrySpec[]; pointerTag: number }> = [];
  if (spec.exif?.length) subs.push({ name: 'Exif', entries: spec.exif, pointerTag: 0x8769 });
  if (spec.gps?.length) subs.push({ name: 'GPS', entries: spec.gps, pointerTag: 0x8825 });

  const groups = [
    { name: 'IFD0' as string, entries: spec.ifd0, pointers: subs.length },
    ...subs.map((sub) => ({ name: sub.name as string, entries: sub.entries, pointers: 0 })),
  ];

  // 布局：header(8) 之后依次是各 IFD 的条目区 + 值区。
  const layout = new Map<string, number>();
  let cursor = 8;
  for (const group of groups) {
    layout.set(group.name, cursor);
    const headerSize = 2 + 12 * (group.entries.length + group.pointers) + 4;
    const valueSize = group.entries.reduce((sum, e) => {
      const len = entryCount(e) * TYPE_WIDTH[e.type]!;
      return sum + (len > 4 ? len + (len & 1) : 0);
    }, 0);
    cursor += headerSize + valueSize;
  }

  const bytes = new Uint8Array(cursor);
  const dv = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);

  for (const group of groups) {
    const at = layout.get(group.name)!;
    const entries = [...group.entries];
    // 子 IFD 指针只写在 IFD0 里（布局也是按 IFD0 预留的）。
    if (group.name === 'IFD0') {
      for (const sub of subs) {
        entries.push({ tag: sub.pointerTag, type: 4, value: [layout.get(sub.name)!] });
      }
    }
    entries.sort((a, b) => a.tag - b.tag);
    dv.setUint16(at, entries.length, true);
    let valueCursor = at + 2 + 12 * entries.length + 4;
    entries.forEach((entry, index) => {
      const entryAt = at + 2 + index * 12;
      const encoded = encodeValue(entry);
      const total = encoded.length;
      dv.setUint16(entryAt, entry.tag, true);
      dv.setUint16(entryAt + 2, entry.type, true);
      dv.setUint32(entryAt + 4, entryCount(entry), true);
      if (total <= 4) {
        bytes.set(encoded, entryAt + 8);
      } else {
        dv.setUint32(entryAt + 8, valueCursor, true);
        bytes.set(encoded, valueCursor);
        valueCursor += total + (total & 1);
      }
    });
    dv.setUint32(at + 2 + entries.length * 12, 0, true);
  }
  return bytes;
}

/** 常用拍摄参数的合成 TIFF（小端）。 */
const SAMPLE_IFD0_ENTRIES: EntrySpec[] = [
  { tag: 0x010f, type: 2, value: 'SONY' },
  { tag: 0x0110, type: 2, value: 'ILCE-7M4' },
  { tag: 0x0131, type: 2, value: 'Kanitsu 0.2' },
];

const SAMPLE_EXIF_ENTRIES: EntrySpec[] = [
  { tag: 0x829a, type: 5, value: [[1, 250]] },
  { tag: 0x829d, type: 5, value: [[8, 5]] },
  { tag: 0x8827, type: 3, value: [400] },
  { tag: 0x9003, type: 2, value: '2024:05:01 12:34:56' },
  { tag: 0x9204, type: 10, value: [[1, 3]] },
  { tag: 0x920a, type: 5, value: [[35, 1]] },
  { tag: 0xa403, type: 3, value: [0] },
  { tag: 0xa405, type: 3, value: [52] },
  { tag: 0xa434, type: 2, value: 'FE 35mm F1.8' },
];

const SAMPLE_GPS_ENTRIES: EntrySpec[] = [
  { tag: 0x0001, type: 2, value: 'N' },
  { tag: 0x0002, type: 5, value: [[31, 1], [13, 1], [48, 1]] },
  { tag: 0x0003, type: 2, value: 'E' },
  { tag: 0x0004, type: 5, value: [[121, 1], [28, 1], [25, 1]] },
  { tag: 0x0006, type: 5, value: [[12, 1]] },
];

function sampleTiff(): Uint8Array {
  return buildTiff({ ifd0: SAMPLE_IFD0_ENTRIES, exif: SAMPLE_EXIF_ENTRIES, gps: SAMPLE_GPS_ENTRIES });
}

function rowMap(result: NonNullable<ReturnType<typeof parseExif>>): Map<string, string> {
  return new Map(result.rows.map((row) => [row.label, row.value]));
}

function expectCoreRows(result: NonNullable<ReturnType<typeof parseExif>>): void {
  const rows = rowMap(result);
  assert.equal(rows.get('拍摄时间'), '2024-05-01 12:34:56');
  assert.equal(rows.get('相机'), 'SONY ILCE-7M4');
  assert.equal(rows.get('镜头'), 'FE 35mm F1.8');
  assert.equal(rows.get('焦距'), '35 mm（等效 52 mm）');
  assert.equal(rows.get('光圈'), 'f/1.6');
  assert.equal(rows.get('快门'), '1/250 秒');
  assert.equal(rows.get('ISO'), 'ISO 400');
  assert.equal(rows.get('曝光补偿'), '+0.333 EV');
  assert.equal(rows.get('白平衡'), '自动');
  assert.equal(rows.get('软件'), 'Kanitsu 0.2');
  assert.equal(rows.get('定位'), '31.23000, 121.47361');
  assert.equal(rows.get('海拔'), '12 m');
}

function wrapJpeg(tiff: Uint8Array): Uint8Array {
  const body = concat(asciiBytes('Exif\0\0'), tiff);
  const segLen = body.length + 2;
  return concat(
    new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff]),
    body,
    new Uint8Array([0xff, 0xd9]),
  );
}

describe('parseExif 容器识别', () => {
  test('JPEG APP1 里的 Exif', () => {
    const result = parseExif(wrapJpeg(sampleTiff()));
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
  });

  test('TIFF 系 RAW（ARW/DNG 风格的裸 TIFF）', () => {
    const result = parseExif(sampleTiff());
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
  });

  test('RW2 变体头（IIU\\0）', () => {
    const bytes = sampleTiff();
    bytes[2] = 0x55; // 'U'，非标准 TIFF magic
    bytes[3] = 0x00;
    const result = parseExif(bytes);
    assert.ok(result, '解析出 EXIF');
    assert.equal(rowMap(result).get('光圈'), 'f/1.6');
  });

  test('ORF 变体头（IIR S / IIRO）', () => {
    for (const [r, s] of [
      [0x52, 0x53], // 'IIR S' → 标识 0x5352
      [0x52, 0x4f], // 'IIRO' → 标识 0x4F52
    ]) {
      const bytes = sampleTiff();
      bytes[2] = r;
      bytes[3] = s;
      const result = parseExif(bytes);
      assert.ok(result, `解析出 EXIF（${r},${s}）`);
      assert.equal(rowMap(result).get('光圈'), 'f/1.6');
    }
  });

  test('PNG 的 eXIf 块', () => {
    const tiff = sampleTiff();
    const chunk = concat(
      u32be(tiff.length),
      asciiBytes('eXIf'),
      tiff,
      new Uint8Array(4), // crc（解析不校验）
    );
    const result = parseExif(concat(asciiBytes('\x89PNG\r\n\x1a\n'), chunk));
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
  });

  test('WebP 的 EXIF 块', () => {
    const body = concat(asciiBytes('Exif\0\0'), sampleTiff());
    const chunk = concat(asciiBytes('EXIF'), u32le(body.length), body, new Uint8Array(body.length & 1));
    const payload = concat(asciiBytes('WEBP'), chunk);
    const result = parseExif(concat(asciiBytes('RIFF'), u32le(payload.length), payload));
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
  });

  test('富士 RAF：取内嵌 JPEG 预览的 Exif', () => {
    const raf = concat(asciiBytes('FUJIFILMCCD-RAW '), new Uint8Array(64), wrapJpeg(sampleTiff()));
    const result = parseExif(raf);
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
  });

  test('PNG 无 eXIf 块时返回 null', () => {
    const png = concat(asciiBytes('\x89PNG\r\n\x1a\n'), u32be(13), asciiBytes('IHDR'), new Uint8Array(13 + 4));
    assert.equal(parseExif(png), null);
  });

  test('GIF 等无 EXIF 概念的容器返回 null', () => {
    assert.equal(parseExif(asciiBytes('GIF89a????????')), null);
  });
});

// —— HEIF/AVIF：meta/iinf/iloc 定位 Exif item ——

function box(type: string, payload: Uint8Array, full?: { version: number; flags: number }): Uint8Array {
  const header = full ? 12 : 8;
  const out = new Uint8Array(header + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(asciiBytes(type), 4);
  if (full) {
    out[8] = full.version & 0xff;
    out[9] = (full.flags >> 16) & 0xff;
    out[10] = (full.flags >> 8) & 0xff;
    out[11] = full.flags & 0xff;
    out.set(payload, 12);
  } else {
    out.set(payload, 8);
  }
  return out;
}

/** HEIF 的 Exif item payload：exif_tiff_header_offset + TIFF。 */
function buildExifItem(tiff: Uint8Array): Uint8Array {
  return concat(u32be(0), tiff);
}

/** 合成把 Exif item 放在 mdat 里的 HEIF；leadBytes 决定 item 在文件里的位置。 */
function buildHeif(exifItem: Uint8Array, leadBytes: number): Uint8Array {
  const build = (exifOffset: number) => {
    const infe = (id: number, type: string): Uint8Array =>
      box('infe', concat(new Uint8Array([0, id, 0, 0]), asciiBytes(type), new Uint8Array(1)), { version: 2, flags: 0 });
    const iinf = box('iinf', concat(new Uint8Array([0, 2]), infe(1, 'hvc1'), infe(2, 'Exif')), { version: 0, flags: 0 });

    // iloc version 0：offset_size=4 length_size=4 base_offset_size=0 index_size=0
    const ilocItem = (id: number, offset: number, length: number): Uint8Array =>
      concat(new Uint8Array([0, id, 0, 0, 0, 1]), u32be(offset), u32be(length));
    const iloc = box(
      'iloc',
      concat(new Uint8Array([0x44, 0x00, 0, 2]), ilocItem(1, 0, 16), ilocItem(2, exifOffset, exifItem.length)),
      { version: 0, flags: 0 },
    );

    const meta = box('meta', concat(box('hdlr', new Uint8Array(8)), iinf, iloc), { version: 0, flags: 0 });
    const ftyp = box('ftyp', concat(asciiBytes('heic'), new Uint8Array(4), asciiBytes('mif1heic')));
    return { ftyp, meta };
  };

  const first = build(0);
  const mdatStart = first.ftyp.length + first.meta.length + 8;
  const second = build(mdatStart + leadBytes);
  return concat(second.ftyp, second.meta, box('mdat', concat(new Uint8Array(leadBytes), exifItem)));
}

function trackedSource(bytes: Uint8Array): ExifByteSource & { reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    size: bytes.length,
    reads,
    read(offset: number, length: number) {
      reads.push([offset, length]);
      return Promise.resolve(bytes.subarray(offset, Math.min(bytes.length, offset + length)));
    },
  };
}

describe('HEIF/AVIF 的 Exif item', () => {
  test('item 落在头部窗口内时直接解析', () => {
    const result = parseExif(buildHeif(buildExifItem(sampleTiff()), 0));
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
  });

  test('item 在头部窗口外时补读该段', async () => {
    // leadBytes 让 Exif item 落在 256KB 头部窗口之外。
    const source = trackedSource(buildHeif(buildExifItem(sampleTiff()), 300 * 1024));
    const result = await readExif(source);
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
    assert.equal(source.reads.length, 2, `读取次数 = ${source.reads.length}`);
    assert.equal(source.reads[0]![0], 0);
    assert.ok(source.reads[1]![0] > 256 * 1024, `补读位置 = ${source.reads[1]![0]}`);
  });
});

// —— Canon CR3：moov > uuid 的 CMT1/CMT2/CMT4 ——

/** ExifTool `%Canon::uuid` 里的 Canon uuid（其后是 CMT1..CMT4 / THMB 等子盒）。 */
const CANON_UUID = new Uint8Array([0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48]);

/** 合成 Canon CR3 风格的 ISO-BMFF；padBytes 把 uuid/moov 撑到头部窗口之外。 */
function buildCr3(padBytes: number): Uint8Array {
  const uuidPayload = concat(
    CANON_UUID,
    box('CMT1', buildTiff({ ifd0: SAMPLE_IFD0_ENTRIES })),
    box('CMT2', buildTiff({ ifd0: SAMPLE_EXIF_ENTRIES })),
    box('CMT3', buildTiff({ ifd0: [{ tag: 0x0006, type: 2, value: 'canon-note' }] })),
    box('CMT4', buildTiff({ ifd0: SAMPLE_GPS_ENTRIES })),
    box('THMB', new Uint8Array(padBytes)),
  );
  return concat(
    box('ftyp', concat(asciiBytes('crx '), new Uint8Array(4), asciiBytes('crx isom'))),
    box('moov', box('uuid', uuidPayload)),
    box('mdat', new Uint8Array(32)),
  );
}

describe('Canon CR3 的 CMT 盒', () => {
  test('CMT1/CMT2/CMT4 合起来是完整拍摄参数', async () => {
    const result = await readExif(trackedSource(buildCr3(0)));
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
  });

  test('moov 超出头部窗口时靠前的 CMT 仍能解析', async () => {
    // THMB（内嵌预览）把 uuid/moov 撑到 300KB：头部窗口截断它，但 CMT 在其之前。
    const source = trackedSource(buildCr3(300 * 1024));
    const result = await readExif(source);
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
    assert.equal(source.reads.length, 1, `读取次数 = ${source.reads.length}`);
  });

  test('CMT3 的厂商 MakerNote 不进结果', () => {
    const result = parseExif(buildCr3(0));
    assert.ok(result);
    assert.ok(!result.fields.some((f) => f.text === 'canon-note'), 'CMT3 未被解析');
    assert.equal(rowMap(result).get('相机'), 'SONY ILCE-7M4');
  });
});

describe('readExif 按需读取', () => {
  test('负载落在头部窗口内时只读一次', async () => {
    const source = trackedSource(wrapJpeg(sampleTiff()));
    const result = await readExif(source);
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
    assert.equal(source.reads.length, 1);
  });
  test('LibraryStore.readSlice 的字节区间可直接喂给 readExif', async () => {
    const store = new MemoryLibraryStore();
    await store.ensureLibraryRoot();
    const folder = await store.createTopFolder('样张');
    const file = await store.writeBlob(folder, 'DSC0001.jpg', new Blob([wrapJpeg(sampleTiff())], { type: 'image/jpeg' }));
    const result = await readExif({
      size: file.size ?? 0,
      read: (offset, length) => store.readSlice(file, offset, length),
    });
    assert.ok(result, '解析出 EXIF');
    expectCoreRows(result);
  });

  test('文件过短或无 EXIF 时返回 null 且不抛错', async () => {
    assert.equal(await readExif(trackedSource(new Uint8Array([1, 2, 3]))), null);
    assert.equal(await readExif(trackedSource(asciiBytes('GIF89a????????????'))), null);
  });
});

describe('拍摄参数行合成', () => {
  test('型号已含厂商名时不再重复拼接', () => {
    const result = parseExif(
      buildTiff({
        ifd0: [
          { tag: 0x010f, type: 2, value: 'Canon' },
          { tag: 0x0110, type: 2, value: 'Canon EOS R5' },
        ],
      }),
    );
    assert.ok(result);
    assert.equal(rowMap(result).get('相机'), 'Canon EOS R5');
  });

  test('缺 FNumber 时用 ApertureValue（APEX）换算光圈', () => {
    const result = parseExif(
      buildTiff({
        ifd0: [{ tag: 0x010f, type: 2, value: 'NIKON' }],
        exif: [{ tag: 0x9202, type: 5, value: [[4, 1]] }], // 2*log2(f) = 4 → f/4
      }),
    );
    assert.ok(result);
    assert.equal(rowMap(result).get('光圈'), 'f/4');
  });

  test('缺 ExposureTime 时用 ShutterSpeedValue（APEX）换算快门', () => {
    const result = parseExif(
      buildTiff({
        ifd0: [{ tag: 0x010f, type: 2, value: 'NIKON' }],
        exif: [{ tag: 0x9201, type: 5, value: [[8, 1]] }], // 2^8 = 256 → 1/256 秒
      }),
    );
    assert.ok(result);
    assert.equal(rowMap(result).get('快门'), '1/256 秒');
  });

  test('全部标签按 IFD 顺序给出，含未收录标签', () => {
    const result = parseExif(
      buildTiff({
        ifd0: [
          { tag: 0x010f, type: 2, value: 'SONY' },
          { tag: 0x9999, type: 2, value: 'private-value' },
        ],
        exif: [{ tag: 0x920a, type: 5, value: [[50, 1]] }],
      }),
    );
    assert.ok(result);
    assert.equal(result.fields[0]!.name, 'Make');
    assert.ok(result.fields.some((f) => f.name === 'Tag0x9999' && f.text === 'private-value'));
    assert.equal(result.fields.at(-1)!.ifd, 'ExifIFD');
    assert.ok(result.fields.length >= 3);
  });

  test('二进制 MakerNote 不进标签列表', () => {
    const result = parseExif(
      buildTiff({
        ifd0: [{ tag: 0x010f, type: 2, value: 'SONY' }],
        exif: [{ tag: 0x927c, type: 7, value: [0x00, 0x01, 0x02, 0xff, 0xfe] }],
      }),
    );
    assert.ok(result);
    assert.ok(!result.fields.some((f) => f.tag === 0x927c));
  });
});
