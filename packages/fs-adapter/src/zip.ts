/**
 * Minimal dependency-free ZIP writer (STORE method, no compression).
 *
 * Images are already compressed, so storing them unchanged is fast and produces a
 * zip that any standard unzip tool reads. Used by the browser/memory album library
 * to export a zip Blob for download. The Electron main process uses the native
 * `archiver` (streaming to a save path) instead.
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

/**
 * Builds a ZIP archive (STORE method) from the given entries, preserving the
 * ordering of `entries`. Returns the raw archive bytes.
 */
export function buildZip(entries: ZipEntry[], modTime = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modTime);

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const offsets: { localOffset: number; name: Uint8Array; crc: number; size: number }[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    const lh = new Uint8Array(30);
    const view = new DataView(lh.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0x0800, true); // UTF-8 filename flag
    view.setUint16(8, 0, true); // method: STORE
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.data.length, true); // compressed size
    view.setUint32(22, entry.data.length, true); // uncompressed size
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // extra length

    localParts.push(lh, nameBytes, entry.data);
    offsets.push({ localOffset: offset, name: nameBytes, crc, size: entry.data.length });
    offset += 30 + nameBytes.length + entry.data.length;
  }

  const centralStart = offset;
  for (const o of offsets) {
    const ch = new Uint8Array(46);
    const view = new DataView(ch.buffer);
    view.setUint32(0, 0x02014b50, true); // central directory header
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, 0x0800, true); // UTF-8 filename flag
    view.setUint16(10, 0, true); // method
    view.setUint16(12, time, true);
    view.setUint16(14, date, true);
    view.setUint32(16, o.crc, true);
    view.setUint32(20, o.size, true); // compressed size
    view.setUint32(24, o.size, true); // uncompressed size
    view.setUint16(28, o.name.length, true);
    view.setUint16(30, 0, true); // extra length
    view.setUint16(32, 0, true); // comment length
    view.setUint16(34, 0, true); // disk number start
    view.setUint16(36, 0, true); // internal attrs
    view.setUint32(38, 0, true); // external attrs
    view.setUint32(42, o.localOffset, true);

    centralParts.push(ch, o.name);
    offset += 46 + o.name.length;
  }

  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true); // end of central directory
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, offsets.length, true);
  view.setUint16(10, offsets.length, true);
  view.setUint32(12, offset - centralStart, true); // central directory size
  view.setUint32(16, centralStart, true); // central directory offset
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
  out.set(eocd, pos);
  return out;
}
