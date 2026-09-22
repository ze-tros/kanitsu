/**
 * EXIF 解析：纯字节操作，零第三方依赖。
 *
 * 覆盖容器：
 *  - JPEG：APP1 段（`Exif\0\0` + TIFF）；
 *  - TIFF 系 RAW：CR2 / NEF / NRW / ARW / DNG / PEF / SRW（标准 TIFF 头），
 *    ORF（`IIR O` / `MMOR`）、RW2（`IIU\0`）头部魔数不同但 IFD 结构一致；
 *  - PNG：`eXIf` 块（裸 TIFF）；WebP：RIFF `EXIF ` 块；
 *  - HEIF / HEIC / AVIF：`meta` → `iinf`（item_type = 'Exif'）+ `iloc` 定位的 Exif item；
 *  - Canon CR3：`moov > uuid` 下的 CMT1（IFD0）/ CMT2（ExifIFD）/ CMT4（GPS）小 TIFF；
 *  - 富士 RAF：取内嵌 JPEG 预览的 APP1。
 *
 * GIF / BMP 无 EXIF 概念；CR3 的 CMT3（Canon MakerNote）是厂商私有标签表，不解析。
 *
 * 解析只依赖原文件的头部与若干小段（TIFF 的值偏移可能落在窗口外，越界标签跳过），
 * 因此入口接 `ExifByteSource`（按区间读），不要求整读大图。
 */

/** 一次解析读取的头部窗口；TIFF 系 RAW 的 IFD 链、JPEG 的 APPn 段都在这个范围内。 */
const HEAD_BYTES = 256 * 1024;
/** Exif 负载长度上限：拦住畸形容器里的巨量 extent_length / 块长度。 */
const MAX_PAYLOAD = 8 * 1024 * 1024;

/** JPEG APP1 与部分 HEIF Exif item 里 TIFF 头前的标识（'Exif' + 两个 NUL）。 */
const EXIF_TIFF_PREFIX = 'Exif\0\0';

/** 按区间读取原文件字节（原始文件，不是解码后的位图）。 */
export interface ExifByteSource {
  /** 原文件总字节数。 */
  readonly size: number;
  /** 读取 [offset, offset + length) 的原始字节；越过文件尾返回更短片段。 */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type ExifIfd = 'IFD0' | 'ExifIFD' | 'GPS' | 'Interop';

/** 有理数对 [分子, 分母]。 */
export type ExifRational = [number, number];
export type ExifRawValue = number | string | number[] | ExifRational[];

export interface ExifField {
  ifd: ExifIfd;
  /** TIFF 标签号。 */
  tag: number;
  /** 标准标识（如 'FNumber'）；未收录的标签给 'Tag0x1234'。 */
  name: string;
  /** 中文标签名；未收录的标签显示十六进制标签号。 */
  label: string;
  /** 格式化后的显示文本。 */
  text: string;
  /** 原始值：字符串 / 数值数组 / 有理数数组。 */
  raw?: ExifRawValue;
}

export interface ExifRow {
  label: string;
  value: string;
}

export interface ExifResult {
  /** 面板优先展示的常用拍摄参数（已排序、已格式化）。 */
  rows: ExifRow[];
  /** 全部已识别标签，按 IFD 顺序（IFD0 → ExifIFD → GPS → Interop）、标签号升序。 */
  fields: ExifField[];
}

// —— 大小端读取（越界返回 0，结构偏移的合法性由调用方保证）——

function u8(b: Uint8Array, i: number): number {
  return i >= 0 && i < b.length ? b[i]! : 0;
}

function u16(b: Uint8Array, i: number, le: boolean): number {
  if (i < 0 || i + 2 > b.length) return 0;
  return le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!;
}

function u32(b: Uint8Array, i: number, le: boolean): number {
  if (i < 0 || i + 4 > b.length) return 0;
  return le
    ? (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | b[i + 3]! * 0x1000000) >>> 0
    : (b[i]! * 0x1000000 | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
}

function i32(b: Uint8Array, i: number, le: boolean): number {
  const value = u32(b, i, le);
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

/** ISO-BMFF 盒长度/偏移用的大端 64 位读取（超 2^53 视为非法，返回 0）。 */
function u64be(b: Uint8Array, i: number): number {
  if (i < 0 || i + 8 > b.length) return 0;
  const value = u32(b, i, false) * 0x100000000 + u32(b, i + 4, false);
  return Number.isSafeInteger(value) ? value : 0;
}

function float32(b: Uint8Array, i: number, le: boolean): number {
  if (i < 0 || i + 4 > b.length) return 0;
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(i, le);
}

function float64(b: Uint8Array, i: number, le: boolean): number {
  if (i < 0 || i + 8 > b.length) return 0;
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(i, le);
}

function fourcc(b: Uint8Array, i: number): string {
  return String.fromCharCode(u8(b, i), u8(b, i + 1), u8(b, i + 2), u8(b, i + 3));
}

function matchAscii(b: Uint8Array, i: number, text: string): boolean {
  if (i < 0 || i + text.length > b.length) return false;
  for (let k = 0; k < text.length; k++) {
    if (b[i + k] !== text.charCodeAt(k)) return false;
  }
  return true;
}

function decodeText(b: Uint8Array, i: number, length: number): string {
  if (i < 0 || length <= 0 || i + length > b.length) return '';
  return new TextDecoder('utf-8').decode(b.subarray(i, i + length));
}

// —— 容器定位：找出 EXIF（TIFF）负载在文件里的位置 ——

interface ExifPayloadRef {
  /** 负载起点（文件内绝对偏移）。 */
  offset: number;
  /** 负载长度（有限值，绝不指向整个大文件）。 */
  length: number;
  /** TIFF 头在负载内的偏移（JPEG 为 6，HEIF 为 exif_tiff_header_offset）。 */
  tiffOffset: number;
}

/**
 * TIFF 头魔数：42 为标准 TIFF/CR2/NEF/ARW/DNG 等；
 * RW2/RWL（`IIU\0`）与 ORF（`IIR O` / `MMOR` / `IIR S`）沿用 TIFF 的 IFD 结构但魔数不同
 * （按各自字节序读出的标识分别为 0x55、0x4F52、0x5352）。
 */
function isTiffMagic(b: Uint8Array, i: number): boolean {
  if (i < 0 || i + 8 > b.length) return false;
  const le = matchAscii(b, i, 'II');
  const be = matchAscii(b, i, 'MM');
  if (!le && !be) return false;
  const magic = u16(b, i + 2, le);
  return magic === 42 || magic === 0x55 || magic === 0x4f52 || magic === 0x5352;
}

function locateJpegExif(b: Uint8Array): ExifPayloadRef | null {
  let pos = 2;
  let guard = 0;
  while (pos + 4 <= b.length && guard++ < 1024) {
    if (b[pos] !== 0xff) break;
    const marker = b[pos + 1]!;
    if (marker === 0xff) {
      pos += 1; // 填充字节
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2; // 无长度段
      continue;
    }
    // EOI/SOS 之后是熵编码图像数据，元数据段不再出现
    if (marker === 0xd9 || marker === 0xda) break;
    const segLen = (b[pos + 2]! << 8) | b[pos + 3]!;
    if (segLen < 2) break;
    const start = pos + 4;
    const length = segLen - 2;
    if (marker === 0xe1 && matchAscii(b, start, EXIF_TIFF_PREFIX)) {
      return { offset: start, length, tiffOffset: 6 };
    }
    pos += 2 + segLen;
  }
  return null;
}

function locateChunkExif(b: Uint8Array, container: 'png' | 'webp'): ExifPayloadRef | null {
  // PNG：8 字节签名后是 [len(4,be) type(4) data(len) crc(4)] 链；
  // WebP：12 字节 RIFF 头后是 [fourcc(4) len(4,le) data(len,补偶)] 链。
  const png = container === 'png';
  let pos = png ? 8 : 12;
  let guard = 0;
  while (pos + 8 <= b.length && guard++ < 4096) {
    const type = png ? fourcc(b, pos + 4) : fourcc(b, pos);
    const len = png ? u32(b, pos, false) : u32(b, pos + 4, true);
    if (len > MAX_PAYLOAD) break;
    const start = pos + 8;
    const isExif = png ? type === 'eXIf' : type === 'EXIF';
    if (isExif) {
      if (len < 8) return null;
      return { offset: start, length: len, tiffOffset: matchAscii(b, start, EXIF_TIFF_PREFIX) ? 6 : 0 };
    }
    if (png && type === 'IEND') break;
    // PNG 块尾还有 4 字节 CRC；WebP 的负载按偶数长度补齐。
    pos = start + len + (png ? 4 : len & 1);
  }
  return null;
}

interface BmffBox {
  type: string;
  start: number;
  end: number;
}

/** 列出 [from, to) 内的 ISO-BMFF 盒（区间已扣除盒头）。 */
function listBoxes(b: Uint8Array, from: number, to: number): BmffBox[] {
  const out: BmffBox[] = [];
  const limit = Math.min(to, b.length);
  let pos = from;
  let guard = 0;
  while (pos + 8 <= limit && guard++ < 8192) {
    let size = u32(b, pos, false);
    const type = fourcc(b, pos + 4);
    let header = 8;
    if (size === 1) {
      size = u64be(b, pos + 8);
      header = 16;
    } else if (size === 0) {
      size = limit - pos;
    }
    if (size < header) break;
    if (pos + size > limit) {
      // 盒体被窗口截断（如 moov 大于头部窗口）：仍返回可见部分，
      // 让调用方能继续往里找 CMT/meta 等靠前的子盒，后续兄弟盒不再解析。
      out.push({ type, start: pos + header, end: limit });
      break;
    }
    out.push({ type, start: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

/**
 * 解析 HEIF/AVIF Exif item 的 TIFF 头偏移：`exif_tiff_header_offset`(u32) + 垫充 + TIFF 头。
 * 规范是大端偏移；个别写入方按小端写，校验失败时换字节序，再退化为在负载前 32 字节里扫描 TIFF 头。
 */
function resolveTiffOffset(b: Uint8Array, at: number, length: number): number {
  const be = 4 + u32(b, at, false);
  if (isTiffMagic(b, at + be)) return be;
  const le = 4 + u32(b, at, true);
  if (isTiffMagic(b, at + le)) return le;
  for (let i = 4; i < Math.min(32, length - 8); i++) {
    if (isTiffMagic(b, at + i)) return i;
  }
  return -1;
}

/**
 * HEIF/AVIF 的 Exif item 位置。负载可能落在 `b`（文件头部窗口）之外，
 * 此时只给出位置，`tiffOffset` 置 -1，待补读后由 resolveTiffOffset 确认。
 */
function heifPayloadRef(b: Uint8Array, itemStart: number, itemLength: number): ExifPayloadRef | null {
  if (itemLength < 8 || itemStart < 0) return null;
  const length = Math.min(itemLength, MAX_PAYLOAD);
  const available = itemStart < b.length ? Math.min(length, b.length - itemStart) : 0;
  if (available < 8) return { offset: itemStart, length, tiffOffset: -1 };
  const tiffOffset = resolveTiffOffset(b, itemStart, available);
  return tiffOffset >= 0 ? { offset: itemStart, length, tiffOffset } : null;
}

/** 从 `meta` 盒里定位 item_type = 'Exif' 的 item 在文件中的位置。 */
function locateHeifExifItem(b: Uint8Array, meta: BmffBox): ExifPayloadRef | null {
  // meta 是 full box（4 字节 version/flags），子盒从 +4 开始。
  const children = listBoxes(b, meta.start + 4, meta.end);
  const iinf = children.find((c) => c.type === 'iinf');
  const iloc = children.find((c) => c.type === 'iloc');
  if (!iinf || !iloc) return null;
  const idat = children.find((c) => c.type === 'idat');

  // iinf（full box）：version 0 → u16 条目数，version ≥ 1 → u32 条目数；条目是 infe 盒。
  const iinfVersion = u8(b, iinf.start);
  const countAt = iinf.start + 4;
  const entryCount = iinfVersion === 0 ? u16(b, countAt, false) : u32(b, countAt, false);
  const entriesAt = countAt + (iinfVersion === 0 ? 2 : 4);
  let exifItemId = -1;
  if (entryCount > 0 && entryCount <= 4096) {
    for (const infe of listBoxes(b, entriesAt, iinf.end)) {
      if (infe.type !== 'infe') continue;
      const version = u8(b, infe.start);
      if (version < 2) continue; // 旧版本没有 item_type
      const idSize = version === 3 ? 4 : 2;
      const itemId = idSize === 4 ? u32(b, infe.start + 4, false) : u16(b, infe.start + 4, false);
      if (fourcc(b, infe.start + 4 + idSize + 2) === 'Exif') {
        exifItemId = itemId;
        break;
      }
    }
  }
  if (exifItemId < 0) return null;

  // iloc（full box）：offset_size/length_size/base_offset_size/index_size 决定字段宽度。
  const ilocVersion = u8(b, iloc.start);
  const sizesAt = iloc.start + 4;
  const offsetSize = u8(b, sizesAt) >> 4;
  const lengthSize = u8(b, sizesAt) & 0x0f;
  const baseOffsetSize = u8(b, sizesAt + 1) >> 4;
  const indexSize = ilocVersion >= 1 ? u8(b, sizesAt + 1) & 0x0f : 0;
  const itemCountAt = sizesAt + 2;
  const itemCount = ilocVersion === 2 ? u32(b, itemCountAt, false) : u16(b, itemCountAt, false);
  let pos = itemCountAt + (ilocVersion === 2 ? 4 : 2);

  const readSized = (at: number, size: number): number => {
    if (size === 8) return u64be(b, at);
    if (size === 4) return u32(b, at, false);
    if (size === 2) return u16(b, at, false);
    return size === 1 ? u8(b, at) : 0;
  };

  for (let i = 0; i < itemCount && i <= 4096; i++) {
    const itemId = ilocVersion === 2 ? u32(b, pos, false) : u16(b, pos, false);
    pos += ilocVersion === 2 ? 4 : 2;
    let construction = 0;
    if (ilocVersion >= 1) {
      construction = u16(b, pos, false) & 0x0f;
      pos += 2;
    }
    pos += 2; // data_reference_index
    const baseOffset = readSized(pos, baseOffsetSize);
    pos += baseOffsetSize;
    const extentCount = u16(b, pos, false);
    pos += 2;
    for (let e = 0; e < extentCount && e <= 64; e++) {
      if (indexSize > 0) pos += indexSize;
      const extentOffset = readSized(pos, offsetSize);
      pos += offsetSize;
      const extentLength = readSized(pos, lengthSize);
      pos += lengthSize;
      if (itemId !== exifItemId || e > 0) continue;
      // construction_method：0 = 相对文件偏移，1 = 相对 idat 盒 payload，其余不支持。
      if (construction > 1) return null;
      const anchor = construction === 1 && idat ? idat.start : 0;
      return heifPayloadRef(b, anchor + baseOffset + extentOffset, extentLength);
    }
  }
  return null;
}

function locateBmffExif(b: Uint8Array): ExifPayloadRef | null {
  const metas: BmffBox[] = [];
  for (const box of listBoxes(b, 0, b.length)) {
    if (box.type === 'meta') metas.push(box);
    else if (box.type === 'moov') {
      for (const child of listBoxes(b, box.start, box.end)) {
        if (child.type === 'meta') metas.push(child);
      }
    }
  }
  for (const meta of metas) {
    const ref = locateHeifExifItem(b, meta);
    if (ref) return ref;
  }
  return null;
}

/** 内嵌 JPEG 预览的 Exif（富士 RAF 走这条）。 */
function locateEmbeddedJpegExif(b: Uint8Array): ExifPayloadRef | null {
  for (let i = 0; i + 16 <= b.length; i++) {
    if (b[i] !== 0xff || b[i + 1] !== 0xd8) continue;
    const ref = locateJpegExif(b.subarray(i));
    if (ref) return { ...ref, offset: ref.offset + i };
  }
  return null;
}

/**
 * 在容器字节里定位 EXIF（TIFF）负载。
 * `bytes` 可以只是文件头部：返回的是文件内绝对偏移，可能落在 `bytes` 之外
 * （HEIF/AVIF 的 Exif item 常在 mdat 里），由调用方补读。
 */
function locateExifPayload(b: Uint8Array): ExifPayloadRef | null {
  if (b.length < 8) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return locateJpegExif(b);
  if (matchAscii(b, 0, '\x89PNG\r\n\x1a\n')) return locateChunkExif(b, 'png');
  if (matchAscii(b, 0, 'RIFF') && matchAscii(b, 8, 'WEBP')) return locateChunkExif(b, 'webp');
  if (matchAscii(b, 4, 'ftyp')) return locateBmffExif(b);
  // TIFF 系 RAW：值偏移可能落在头部窗口外，先按窗口长度解析，越界标签跳过。
  if (isTiffMagic(b, 0)) return { offset: 0, length: b.length, tiffOffset: 0 };
  if (matchAscii(b, 0, 'FUJIFILMCCD-RAW ')) return locateEmbeddedJpegExif(b);
  return null;
}

// —— TIFF/IFD 解析 ——

const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

interface TagMeta {
  name: string;
  label: string;
}

/** 结构性指针标签：转到子 IFD，自身不进结果。 */
const SUB_IFD_POINTERS: Record<number, ExifIfd> = {
  0x8769: 'ExifIFD',
  0x8825: 'GPS',
  0xa005: 'Interop',
};

const IFD0_TAGS: Record<number, TagMeta> = {
  0x0100: { name: 'ImageWidth', label: '图像宽度' },
  0x0101: { name: 'ImageLength', label: '图像高度' },
  0x0102: { name: 'BitsPerSample', label: '位深' },
  0x0103: { name: 'Compression', label: '压缩方式' },
  0x010e: { name: 'ImageDescription', label: '描述' },
  0x010f: { name: 'Make', label: '制造商' },
  0x0110: { name: 'Model', label: '型号' },
  0x0112: { name: 'Orientation', label: '方向' },
  0x011a: { name: 'XResolution', label: 'X 分辨率' },
  0x011b: { name: 'YResolution', label: 'Y 分辨率' },
  0x0128: { name: 'ResolutionUnit', label: '分辨率单位' },
  0x0131: { name: 'Software', label: '软件' },
  0x0132: { name: 'DateTime', label: '文件时间' },
  0x013b: { name: 'Artist', label: '作者' },
  0x8298: { name: 'Copyright', label: '版权' },
};

const EXIF_TAGS: Record<number, TagMeta> = {
  0x829a: { name: 'ExposureTime', label: '快门' },
  0x829d: { name: 'FNumber', label: '光圈' },
  0x8822: { name: 'ExposureProgram', label: '曝光程序' },
  0x8827: { name: 'ISOSpeedRatings', label: 'ISO' },
  0x8830: { name: 'SensitivityType', label: '感光度类型' },
  0x8832: { name: 'PhotographicSensitivity', label: 'ISO' },
  0x9003: { name: 'DateTimeOriginal', label: '拍摄时间' },
  0x9004: { name: 'DateTimeDigitized', label: '数字化时间' },
  0x9201: { name: 'ShutterSpeedValue', label: '快门（APEX）' },
  0x9202: { name: 'ApertureValue', label: '光圈（APEX）' },
  0x9203: { name: 'BrightnessValue', label: '亮度' },
  0x9204: { name: 'ExposureBiasValue', label: '曝光补偿' },
  0x9205: { name: 'MaxApertureValue', label: '最大光圈（APEX）' },
  0x9206: { name: 'SubjectDistance', label: '主体距离' },
  0x9207: { name: 'MeteringMode', label: '测光' },
  0x9208: { name: 'LightSource', label: '光源' },
  0x9209: { name: 'Flash', label: '闪光灯' },
  0x920a: { name: 'FocalLength', label: '焦距' },
  0x9286: { name: 'UserComment', label: '注释' },
  0xa001: { name: 'ColorSpace', label: '色彩空间' },
  0xa002: { name: 'PixelXDimension', label: '像素宽度' },
  0xa003: { name: 'PixelYDimension', label: '像素高度' },
  0xa401: { name: 'CustomRendered', label: '自定义渲染' },
  0xa402: { name: 'ExposureMode', label: '曝光模式' },
  0xa403: { name: 'WhiteBalance', label: '白平衡' },
  0xa404: { name: 'DigitalZoomRatio', label: '数码变焦' },
  0xa405: { name: 'FocalLengthIn35mmFilm', label: '等效焦距' },
  0xa406: { name: 'SceneCaptureType', label: '场景类型' },
  0xa408: { name: 'Contrast', label: '对比度' },
  0xa409: { name: 'Saturation', label: '饱和度' },
  0xa40a: { name: 'Sharpness', label: '锐度' },
  0xa40c: { name: 'SubjectDistanceRange', label: '主体距离范围' },
  0xa430: { name: 'CameraOwnerName', label: '机身持有者' },
  0xa431: { name: 'BodySerialNumber', label: '机身序列号' },
  0xa432: { name: 'LensSpecification', label: '镜头规格' },
  0xa433: { name: 'LensMake', label: '镜头厂商' },
  0xa434: { name: 'LensModel', label: '镜头型号' },
  0xa435: { name: 'LensSerialNumber', label: '镜头序列号' },
};

const GPS_TAGS: Record<number, TagMeta> = {
  0x0001: { name: 'GPSLatitudeRef', label: '纬度半球' },
  0x0002: { name: 'GPSLatitude', label: '纬度' },
  0x0003: { name: 'GPSLongitudeRef', label: '经度半球' },
  0x0004: { name: 'GPSLongitude', label: '经度' },
  0x0005: { name: 'GPSAltitudeRef', label: '海拔基准' },
  0x0006: { name: 'GPSAltitude', label: '海拔' },
  0x0007: { name: 'GPSTimeStamp', label: '定位时间' },
  0x0008: { name: 'GPSSatellites', label: '卫星' },
  0x0012: { name: 'GPSMapDatum', label: '大地基准' },
  0x001d: { name: 'GPSDateStamp', label: '定位日期' },
};

const INTEROP_TAGS: Record<number, TagMeta> = {
  0x0001: { name: 'InteropIndex', label: '互操作标识' },
};

function tagMeta(ifd: ExifIfd, tag: number): TagMeta {
  const table = ifd === 'IFD0' ? IFD0_TAGS : ifd === 'ExifIFD' ? EXIF_TAGS : ifd === 'GPS' ? GPS_TAGS : INTEROP_TAGS;
  return (
    table[tag] ?? {
      name: `Tag0x${tag.toString(16).padStart(4, '0')}`,
      label: `0x${tag.toString(16).toUpperCase().padStart(4, '0')}`,
    }
  );
}

// —— 数值格式化 ——

/** 去掉多余小数位（最多 3 位）与尾随 0。 */
function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toFixed(3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function rationalValue(pair: ExifRational): number | null {
  const [n, d] = pair;
  return d ? n / d : null;
}

function firstNumber(raw: ExifRawValue | undefined): number | null {
  if (typeof raw === 'string') return null;
  if (typeof raw === 'number') return raw;
  if (!raw || raw.length === 0) return null;
  const head = raw[0] as number | ExifRational;
  return Array.isArray(head) ? rationalValue(head) : head;
}

/** 快门时间：小于 1 秒用 1/N 表示，与相机屏幕一致。 */
function formatExposureTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return seconds < 1 ? `1/${Math.round(1 / seconds)} 秒` : `${trimNumber(seconds)} 秒`;
}

/** APEX 快门值换算成秒（ShutterSpeedValue 为 -log2(秒)）。 */
function apexExposure(apex: number): number {
  return 2 ** -apex;
}

/** APEX 光圈值换算成 f/ 数（ApertureValue 为 2*log2(f 数)）。 */
function apexAperture(apex: number): number {
  return 2 ** (apex / 2);
}

const ENUM_TEXT: Record<string, Record<number, string>> = {
  Flash: {
    0x0: '未闪光',
    0x1: '闪光',
    0x5: '闪光（强制）',
    0x7: '闪光（强制）',
    0x9: '闪光（强制）',
    0xd: '闪光（强制）',
    0x8: '未闪光（强制）',
    0xc: '未闪光（强制）',
    0x10: '未闪光（红眼消除）',
    0x18: '未闪光（自动）',
    0x19: '闪光（自动）',
    0x1d: '闪光（自动）',
    0x1f: '闪光（自动）',
  },
  MeteringMode: {
    0: '未知',
    1: '平均测光',
    2: '中央重点测光',
    3: '点测光',
    4: '多点测光',
    5: '矩阵测光',
    6: '部分测光',
  },
  LightSource: {
    0: '自动',
    1: '日光',
    2: '荧光灯',
    3: '钨丝灯',
    4: '闪光灯',
    9: '晴天',
    10: '阴天',
    11: '阴影',
    12: '日光荧光灯',
    13: '白光荧光灯',
    14: '暖光荧光灯',
    15: '冷光荧光灯',
    17: '标准光源 A',
    18: '标准光源 B',
    19: '标准光源 C',
    255: '其他',
  },
  Orientation: {
    1: '正常',
    2: '水平镜像',
    3: '旋转 180°',
    4: '垂直镜像',
    5: '转置',
    6: '顺时针 90°',
    7: '横向转置',
    8: '逆时针 90°',
  },
  WhiteBalance: { 0: '自动', 1: '手动' },
  ExposureMode: { 0: '自动', 1: '手动', 2: '自动包围' },
  ExposureProgram: {
    0: '未定义',
    1: '手动',
    2: '程序自动',
    3: '光圈优先',
    4: '快门优先',
    5: '慢速同步',
    6: '高速同步',
    7: '人像',
    8: '风景',
  },
  SceneCaptureType: {
    0: '标准',
    1: '风景',
    2: '人像',
    3: '夜景',
    4: '聚会',
    5: '沙滩',
    6: '雪景',
    7: '日落',
    8: '夜景人像',
    9: '逆光',
  },
  ColorSpace: { 1: 'sRGB', 2: 'Adobe RGB', 65535: '未校准' },
  CustomRendered: { 0: '正常', 1: '特殊处理' },
  SubjectDistanceRange: { 0: '未知', 1: '微距', 2: '近距', 3: '远距' },
  ResolutionUnit: { 2: '英寸', 3: '厘米' },
  GPSAltitudeRef: { 0: '海平面以上', 1: '海平面以下' },
  SensitivityType: {
    0: '未知',
    1: '标准输出感光度',
    2: '推荐曝光指数',
    3: 'ISO 速度',
    4: '标准输出与推荐曝光指数',
    5: '推荐曝光指数与 ISO 速度',
    6: '标准输出与 ISO 速度',
    7: '标准输出、推荐曝光指数与 ISO 速度',
  },
};

function formatDateTime(text: string): string {
  // EXIF 写作 'YYYY:MM:DD HH:MM:SS'，显示成 'YYYY-MM-DD HH:MM:SS'。
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(text.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : text.trim();
}

function isPrintableText(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 0xfffd) return false;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) return false;
  }
  return true;
}

function decodeUserComment(buf: Uint8Array, offset: number, length: number): string {
  // 前 8 字节是字符集标识（ASCII / UNICODE / JIS / 未定义），其后才是正文。
  if (length <= 8) return '';
  const charset = decodeText(buf, offset, 8).replace(/\0/g, '');
  const body = decodeText(buf, offset + 8, length - 8);
  return charset === 'UNICODE' ? body.replace(/\0/g, '').trim() : body.trim();
}

interface DecodedValue {
  text: string;
  raw: ExifRawValue;
}

function decodeValue(buf: Uint8Array, offset: number, type: number, count: number, le: boolean, tag: number): DecodedValue | null {
  if (type === 2) {
    const nul = buf.indexOf(0, offset);
    const stop = nul < 0 || nul - offset > count ? offset + count : nul;
    const text = decodeText(buf, offset, Math.max(0, stop - offset)).trim();
    return text ? { text, raw: text } : null;
  }
  if (type === 7) {
    if (tag === 0x9286) {
      const text = decodeUserComment(buf, offset, count);
      return text ? { text, raw: text } : null;
    }
    // MakerNote 等二进制负载不可读，不进标签列表。
    const text = decodeText(buf, offset, count).replace(/\0/g, '').trim();
    return text && isPrintableText(text) ? { text, raw: text } : null;
  }
  if (type === 5 || type === 10) {
    const pairs: ExifRational[] = [];
    for (let i = 0; i < count; i++) {
      const at = offset + i * 8;
      const n = type === 5 ? u32(buf, at, le) : i32(buf, at, le);
      const d = type === 5 ? u32(buf, at + 4, le) : i32(buf, at + 4, le);
      pairs.push([n, d]);
    }
    const text = pairs
      .map((pair) => {
        const value = rationalValue(pair);
        return value === null ? '' : trimNumber(value);
      })
      .filter(Boolean)
      .join(', ');
    return text ? { text, raw: pairs } : null;
  }
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = offset + i * (TYPE_SIZE[type] ?? 0);
    if (type === 1 || type === 7) values.push(u8(buf, at));
    else if (type === 3) values.push(u16(buf, at, le));
    else if (type === 4) values.push(u32(buf, at, le));
    else if (type === 6) values.push((u8(buf, at) << 24) >> 24);
    else if (type === 8) values.push((u16(buf, at, le) << 16) >> 16);
    else if (type === 9) values.push(i32(buf, at, le));
    else if (type === 11) values.push(float32(buf, at, le));
    else if (type === 12) values.push(float64(buf, at, le));
    else return null;
  }
  const text = values.map((v) => trimNumber(v)).join(', ');
  return text ? { text, raw: values } : null;
}

function formatFieldText(name: string, decoded: DecodedValue): string {
  const single = firstNumber(decoded.raw);
  switch (name) {
    case 'DateTimeOriginal':
    case 'DateTimeDigitized':
    case 'DateTime':
      return formatDateTime(decoded.text);
    case 'ExposureTime':
      return single === null ? '' : formatExposureTime(single);
    case 'FNumber':
      return single === null ? '' : `f/${trimNumber(single)}`;
    case 'FocalLength':
      return single === null ? '' : `${trimNumber(single)} mm`;
    case 'FocalLengthIn35mmFilm':
      return single === null || single === 0 ? '' : `${trimNumber(single)} mm`;
    case 'ISOSpeedRatings':
    case 'PhotographicSensitivity':
      return single === null ? '' : `ISO ${trimNumber(single)}`;
    case 'ExposureBiasValue':
      return single === null ? '' : `${single > 0 ? '+' : ''}${trimNumber(single)} EV`;
    case 'DigitalZoomRatio':
      return single === null || single === 0 ? '' : `${trimNumber(single)}×`;
    default: {
      const enums = ENUM_TEXT[name];
      if (enums && single !== null && enums[single]) return enums[single]!;
      return decoded.text;
    }
  }
}

function collectIfd(buf: Uint8Array, base: number, ifdOffset: number, ifd: ExifIfd, le: boolean, out: ExifField[], depth: number): void {
  if (depth > 3 || ifdOffset <= 0) return;
  const at = base + ifdOffset;
  if (at + 2 > buf.length) return;
  const count = u16(buf, at, le);
  if (count === 0 || count > 1024) return;
  for (let i = 0; i < count; i++) {
    const entry = at + 2 + i * 12;
    if (entry + 12 > buf.length) return;
    const tag = u16(buf, entry, le);
    const type = u16(buf, entry + 2, le);
    const num = u32(buf, entry + 4, le);
    const valueOffset = u32(buf, entry + 8, le);
    const subIfd = SUB_IFD_POINTERS[tag];
    if (subIfd) {
      // 内联或间接存放，取到的都是目标 IFD 相对 TIFF 头的偏移。
      collectIfd(buf, base, valueOffset, subIfd, le, out, depth + 1);
      continue;
    }
    const size = TYPE_SIZE[type];
    if (!size || num > 8192) continue;
    const total = num * size;
    if (total > 256 * 1024) continue;
    const src = total <= 4 ? entry + 8 : base + valueOffset;
    if (src < 0 || src + total > buf.length) continue;
    const decoded = decodeValue(buf, src, type, num, le, tag);
    if (!decoded) continue;
    const meta = tagMeta(ifd, tag);
    out.push({ ifd, tag, name: meta.name, label: meta.label, text: formatFieldText(meta.name, decoded), raw: decoded.raw });
  }
}

function sortFields(fields: ExifField[]): ExifField[] {
  const order: ExifIfd[] = ['IFD0', 'ExifIFD', 'GPS', 'Interop'];
  return [...fields].sort((a, b) => {
    const group = order.indexOf(a.ifd) - order.indexOf(b.ifd);
    return group !== 0 ? group : a.tag - b.tag;
  });
}

function resultOf(fields: ExifField[]): ExifResult | null {
  if (fields.length === 0) return null;
  const sorted = sortFields(fields);
  return { rows: buildExifRows(sorted), fields: sorted };
}

/**
 * 解析一段 TIFF（base 指向 TIFF 头）里的标签。
 * `rootIfd` 标注首个 IFD 的语义：JPEG/PNG 等容器里是 IFD0；Canon CR3 的
 * CMT2/CMT4 各是一段独立小 TIFF，其首个 IFD 就是 ExifIFD / GPS IFD。
 */
function collectTiffFields(buf: Uint8Array, base: number, rootIfd: ExifIfd, out: ExifField[]): void {
  if (base < 0 || base + 8 > buf.length || !isTiffMagic(buf, base)) return;
  const le = buf[base] === 0x49;
  collectIfd(buf, base, u32(buf, base + 4, le), rootIfd, le, out, 0);
}

function parseExifTiff(buf: Uint8Array, base: number): ExifResult | null {
  const fields: ExifField[] = [];
  collectTiffFields(buf, base, 'IFD0', fields);
  return resultOf(fields);
}

/**
 * Canon CR3：EXIF 不在 TIFF/Exif item 里，而是拆在 `moov > uuid` 下的 CMT1..CMT4
 * 四个小 TIFF 盒（CMT1 = IFD0，CMT2 = ExifIFD，CMT3 = Canon MakerNote，CMT4 = GPS）。
 * 每个 CMT payload 自带 8 字节 TIFF 头，内部偏移相对 payload 起点；CMT3 是厂商私有
 * 标签表，不在通用解析范围。`moov` 大于头部窗口时靠前的 CMT 仍可见（见 listBoxes）。
 */
function collectCr3Fields(b: Uint8Array, out: ExifField[]): void {
  const cmts = new Map<string, BmffBox>();
  for (const moov of listBoxes(b, 0, b.length)) {
    if (moov.type !== 'moov') continue;
    for (const uuid of listBoxes(b, moov.start, moov.end)) {
      if (uuid.type !== 'uuid') continue;
      // uuid 盒 payload 先是 16 字节 usertype，其后才是子盒链。
      for (const child of listBoxes(b, uuid.start + 16, uuid.end)) {
        if (/^CMT[1-4]$/.test(child.type)) cmts.set(child.type, child);
      }
    }
  }
  const roots: Array<[string, ExifIfd]> = [
    ['CMT1', 'IFD0'],
    ['CMT2', 'ExifIFD'],
    ['CMT4', 'GPS'],
  ];
  for (const [type, ifd] of roots) {
    const box = cmts.get(type);
    if (box) collectTiffFields(b, box.start, ifd, out);
  }
}

// —— 拍摄参数行合成 ——

function gpsCoordinate(by: Map<string, ExifField>, refName: string, coordName: string): number | null {
  const coord = by.get(coordName);
  if (!coord || !coord.raw || typeof coord.raw === 'string' || typeof coord.raw === 'number') return null;
  const parts = (coord.raw as Array<number | ExifRational>).map((item) =>
    Array.isArray(item) ? (rationalValue(item) ?? 0) : item,
  );
  const value = (parts[0] ?? 0) + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600;
  const ref = (by.get(refName)?.text ?? '').trim().toUpperCase();
  return ref === 'S' || ref === 'W' ? -value : value;
}

/** 把解析出的标签合成面板优先展示的拍摄参数行。 */
export function buildExifRows(fields: ExifField[]): ExifRow[] {
  const by = new Map<string, ExifField>();
  for (const field of fields) {
    if (!by.has(field.name)) by.set(field.name, field);
  }
  const rows: ExifRow[] = [];
  const add = (label: string, value: string | undefined | null) => {
    const text = (value ?? '').trim();
    if (text) rows.push({ label, value: text });
  };
  const text = (name: string): string => by.get(name)?.text ?? '';
  const valueOf = (name: string): number | null => firstNumber(by.get(name)?.raw);

  add('拍摄时间', text('DateTimeOriginal') || text('DateTimeDigitized') || text('DateTime'));

  const make = text('Make');
  const model = text('Model');
  const camera = model && make && model.toUpperCase().startsWith(make.toUpperCase()) ? model : [make, model].filter(Boolean).join(' ');
  add('相机', camera);

  const lensMake = text('LensMake');
  const lensModel = text('LensModel');
  add('镜头', lensModel ? [lensMake, lensModel].filter(Boolean).join(' ') : lensMake);

  const focal = valueOf('FocalLength');
  const focal35 = valueOf('FocalLengthIn35mmFilm');
  if (focal !== null) {
    add('焦距', `${trimNumber(focal)} mm${focal35 ? `（等效 ${trimNumber(focal35)} mm）` : ''}`);
  } else if (focal35) {
    add('焦距', `等效 ${trimNumber(focal35)} mm`);
  }

  const fNumber = valueOf('FNumber');
  const apexApertureValue = valueOf('ApertureValue');
  add(
    '光圈',
    fNumber !== null ? `f/${trimNumber(fNumber)}` : apexApertureValue === null ? '' : `f/${trimNumber(apexAperture(apexApertureValue))}`,
  );

  const exposure = valueOf('ExposureTime');
  const apexShutter = valueOf('ShutterSpeedValue');
  add('快门', exposure !== null ? formatExposureTime(exposure) : apexShutter === null ? '' : formatExposureTime(apexExposure(apexShutter)));

  add('ISO', text('PhotographicSensitivity') || text('ISOSpeedRatings'));
  add('曝光补偿', text('ExposureBiasValue'));
  add('白平衡', text('WhiteBalance'));
  add('闪光灯', text('Flash'));
  add('测光', text('MeteringMode'));
  add('场景', text('SceneCaptureType'));
  add('软件', text('Software'));
  add('作者', text('Artist'));

  const lat = gpsCoordinate(by, 'GPSLatitudeRef', 'GPSLatitude');
  const lon = gpsCoordinate(by, 'GPSLongitudeRef', 'GPSLongitude');
  if (lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon)) {
    add('定位', `${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    const alt = valueOf('GPSAltitude');
    if (alt !== null) add('海拔', `${trimNumber(alt)} m`);
  }

  return rows;
}

/** 从一段字节（文件头部或整文件）里找并解析 EXIF。 */
export function parseExif(bytes: Uint8Array): ExifResult | null {
  const fields: ExifField[] = [];
  const ref = locateExifPayload(bytes);
  if (ref && ref.offset >= 0 && ref.offset < bytes.length) {
    const available = Math.min(ref.length, bytes.length - ref.offset);
    const tiffOffset = ref.tiffOffset >= 0 ? ref.tiffOffset : resolveTiffOffset(bytes, ref.offset, available);
    if (tiffOffset >= 0 && available >= 8) collectTiffFields(bytes, ref.offset + tiffOffset, 'IFD0', fields);
  }
  // Canon CR3 走 ISO-BMFF 容器但不产 Exif item，单独从 CMT 盒取。
  if (matchAscii(bytes, 4, 'ftyp')) collectCr3Fields(bytes, fields);
  return resultOf(fields);
}

/**
 * 按需读取原文件区间并解析 EXIF。
 * 先读头部窗口一次；HEIF/AVIF 的 Exif item 落在窗口外时补读该段。
 */
export async function readExif(source: ExifByteSource): Promise<ExifResult | null> {
  const headLength = Math.min(source.size, HEAD_BYTES);
  if (headLength < 8) return null;
  const head = await source.read(0, headLength);
  const direct = parseExif(head);
  if (direct) return direct;
  const ref = locateExifPayload(head);
  if (!ref || ref.offset < 0) return null;
  const need = Math.min(ref.length, MAX_PAYLOAD);
  const covered = ref.offset + need <= head.length;
  const payload = covered ? head.subarray(ref.offset, ref.offset + need) : await source.read(ref.offset, need);
  const tiffOffset = ref.tiffOffset >= 0 ? ref.tiffOffset : resolveTiffOffset(payload, 0, payload.length);
  return tiffOffset >= 0 ? parseExifTiff(payload, tiffOffset) : null;
}
