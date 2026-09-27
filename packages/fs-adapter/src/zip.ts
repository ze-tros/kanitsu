/**
 * Minimal dependency-free ZIP writer (STORE method, no compression).
 *
 * Images are already compressed, so storing them unchanged is fast and produces a
 * zip that any standard unzip tool reads. Used by the browser/memory album library
 * to export a zip Blob for download. The Electron main process uses the native
 * `archiver` (streaming to a save path) instead.
 *
 * ZIP64：条目大小 ≥ 4GiB、中央目录偏移 ≥ 4GiB 或条目数 > 65535 时按 PKWARE APPNOTE
 * 写入 0xFFFFFFFF/0xFFFF 哨兵值 + 0x0001 扩展字段 + ZIP64 EOCD/Locator，
 * 不再静默截断产出损坏的归档。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Archive-relative path, `/`-separated, e.g. `MangaA/Vol.01/p001.jpg`. */
  name: string;
  data: Uint8Array;
}

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;

/** 小端写入 64 位值（Number 精度内，≤ 2^53）：低 32 位在前、高 32 位在后。 */
function setU64(view: DataView, pos: number, value: number): void {
  view.setUint32(pos, value >>> 0, true);
  view.setUint32(pos + 4, Math.floor(value / 0x100000000) >>> 0, true);
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const min = date.getMinutes();
  const sec = date.getSeconds();
  const time = (hour << 11) | (min << 5) | (sec >> 1);
  const dateBits = ((year - 1980) << 9) | (month << 5) | day;
  return { time, date: dateBits };
}

/** 构造 ZIP64 扩展字段（0x0001）：按 APPNOTE 顺序放入哨兵字段对应的 64 位值。 */
function zip64Extra(values: number[]): Uint8Array {
  const extra = new Uint8Array(4 + values.length * 8);
  const view = new DataView(extra.buffer);
  view.setUint16(0, ZIP64_EXTRA_ID, true);
  view.setUint16(2, values.length * 8, true);
  values.forEach((value, i) => setU64(view, 4 + i * 8, value));
  return extra;
}

/**
 * Builds a ZIP archive (STORE method) from the given entries, preserving the
 * ordering of `entries`. Returns the raw archive bytes.
 */
export function buildZip(entries: ZipEntry[], modTime = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modTime);

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const offsets: { localOffset: number; name: Uint8Array; crc: number; size: number; zip64: boolean }[] = [];
  let offset = 0;
  let anyZip64 = false;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    // 本地头的大小字段超 32 位：写哨兵值，真实值放 ZIP64 扩展字段。
    const sizeZip64 = size >= U32_MAX;
    anyZip64 ||= sizeZip64;
    const localExtra = sizeZip64 ? zip64Extra([size, size]) : null;

    const lh = new Uint8Array(30);
    const view = new DataView(lh.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header
    view.setUint16(4, sizeZip64 ? 45 : 20, true); // version needed
    view.setUint16(6, 0x0800, true); // UTF-8 filename flag
    view.setUint16(8, 0, true); // method: STORE
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, sizeZip64 ? U32_MAX : size, true); // compressed size
    view.setUint32(22, sizeZip64 ? U32_MAX : size, true); // uncompressed size
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, localExtra?.length ?? 0, true); // extra length

    localParts.push(lh, nameBytes);
    if (localExtra) localParts.push(localExtra);
    localParts.push(entry.data);
    offsets.push({ localOffset: offset, name: nameBytes, crc, size, zip64: sizeZip64 });
    offset += 30 + nameBytes.length + (localExtra?.length ?? 0) + size;
  }

  const centralStart = offset;
  for (const o of offsets) {
    const offsetZip64 = o.localOffset >= U32_MAX;
    const zip64 = o.zip64 || offsetZip64;
    anyZip64 ||= offsetZip64;
    // 中央目录的扩展字段按 [原始大小, 压缩大小, 头部偏移] 顺序，只包含哨兵化的字段。
    const extraValues: number[] = [];
    if (o.zip64) extraValues.push(o.size, o.size);
    if (offsetZip64) extraValues.push(o.localOffset);
    const extra = zip64 ? zip64Extra(extraValues) : null;

    const ch = new Uint8Array(46);
    const view = new DataView(ch.buffer);
    view.setUint32(0, 0x02014b50, true); // central directory header
    view.setUint16(4, zip64 ? 45 : 20, true); // version made by
    view.setUint16(6, zip64 ? 45 : 20, true); // version needed
    view.setUint16(8, 0x0800, true); // UTF-8 filename flag
    view.setUint16(10, 0, true); // method
    view.setUint16(12, time, true);
    view.setUint16(14, date, true);
    view.setUint32(16, o.crc, true);
    view.setUint32(20, o.zip64 ? U32_MAX : o.size, true); // compressed size
    view.setUint32(24, o.zip64 ? U32_MAX : o.size, true); // uncompressed size
    view.setUint16(28, o.name.length, true);
    view.setUint16(30, extra?.length ?? 0, true); // extra length
    view.setUint16(32, 0, true); // comment length
    view.setUint16(34, 0, true); // disk number start
    view.setUint16(36, 0, true); // internal attrs
    view.setUint32(38, 0, true); // external attrs
    view.setUint32(42, offsetZip64 ? U32_MAX : o.localOffset, true);

    centralParts.push(ch, o.name);
    if (extra) centralParts.push(extra);
    offset += 46 + o.name.length + (extra?.length ?? 0);
  }

  const cdSize = offset - centralStart;
  const eocd64Needed = anyZip64 || offsets.length > U16_MAX || cdSize >= U32_MAX || centralStart >= U32_MAX;

  let eocd64Offset = 0;
  const tailParts: Uint8Array[] = [];
  if (eocd64Needed) {
    // ZIP64 EOCD 记录（56 字节）+ Locator（20 字节），紧随中央目录、EOCD 之前。
    eocd64Offset = offset;
    const record = new Uint8Array(56);
    const rv = new DataView(record.buffer);
    rv.setUint32(0, 0x06064b50, true);
    setU64(rv, 4, 44); // 记录固定长度（不含签名与长度字段本身）
    rv.setUint16(12, 45, true); // version made by
    rv.setUint16(14, 45, true); // version needed
    rv.setUint32(16, 0, true); // disk number
    rv.setUint32(20, 0, true); // central directory disk
    setU64(rv, 24, offsets.length);
    setU64(rv, 32, offsets.length);
    setU64(rv, 40, cdSize);
    setU64(rv, 48, centralStart);
    tailParts.push(record);

    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setUint32(4, 0, true); // zip64 EOCD 所在磁盘
    setU64(lv, 8, eocd64Offset);
    lv.setUint32(16, 1, true); // 磁盘总数
    tailParts.push(locator);
    offset += 56 + 20;
  }

  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true); // end of central directory
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, eocd64Needed ? U16_MAX : Math.min(offsets.length, U16_MAX), true);
  view.setUint16(10, eocd64Needed ? U16_MAX : Math.min(offsets.length, U16_MAX), true);
  view.setUint32(12, eocd64Needed ? U32_MAX : Math.min(cdSize, U32_MAX), true); // central directory size
  view.setUint32(16, eocd64Needed ? U32_MAX : Math.min(centralStart, U32_MAX), true); // central directory offset
  view.setUint16(20, 0, true); // comment length

  const total = offset + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of tailParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);
  return out;
}
