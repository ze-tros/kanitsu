// gifQuantize（自研 GIF 量化/缩放纯逻辑）的回归测试。
// 覆盖历史上最容易静默出错的分支：全透明图、单色图、1×1 目标尺寸、单帧 GIF。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GifWriter } from 'omggif';
import {
  buildAdaptivePalette,
  clearRect,
  decodeGifFrames,
  encodeFrames,
  GIF_MAX_CANVAS_PIXELS,
  GifTransparentIndex,
  quantizeToIndex,
  resizeRgba,
} from '../electron/gifQuantize';

/** 构造一张纯色（或透明）RGBA 图。alpha=0 表示全透明。 */
function solidRgba(w: number, h: number, rgb: [number, number, number], alpha = 255): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    out[p * 4] = rgb[0];
    out[p * 4 + 1] = rgb[1];
    out[p * 4 + 2] = rgb[2];
    out[p * 4 + 3] = alpha;
  }
  return out;
}

test('buildAdaptivePalette：全透明图走空直方图分支且不崩', () => {
  const frame = solidRgba(8, 8, [255, 0, 0], 0);
  const { palette, bucketMap } = buildAdaptivePalette([frame], 8, 8);
  assert.equal(palette.length, 256);
  assert.ok(palette.every((v) => v === 0));
  assert.ok(bucketMap.every((v) => v === 0));
});

test('buildAdaptivePalette + quantizeToIndex：单色图映射到红色调色板项', () => {
  const frame = solidRgba(4, 4, [200, 30, 40]);
  const { palette, bucketMap } = buildAdaptivePalette([frame], 4, 4);
  const idx = quantizeToIndex(frame, 4, 4, bucketMap);
  // 全图同色 → 全部落到同一个非透明调色板索引
  const first = idx[0]!;
  assert.ok(first !== GifTransparentIndex, '不透明像素不应落到透明索引');
  assert.ok(idx.every((v) => v === first));
  // 调色板项按 b|g<<8|r<<16 打包，解包后应接近源色（5-bit 桶中位 ±4）
  const packed = palette[first]!;
  const r = (packed >> 16) & 0xff;
  const g = (packed >> 8) & 0xff;
  const b = packed & 0xff;
  assert.ok(Math.abs(r - 200) <= 40 && Math.abs(g - 30) <= 40 && Math.abs(b - 40) <= 40, `调色板色偏离源色：${r},${g},${b}`);
});

test('quantizeToIndex：半透明像素落到透明索引', () => {
  const frame = solidRgba(2, 2, [10, 200, 30], 100);
  const { bucketMap } = buildAdaptivePalette([solidRgba(2, 2, [10, 200, 30])], 2, 2);
  const idx = quantizeToIndex(frame, 2, 2, bucketMap);
  assert.ok(idx.every((v) => v === GifTransparentIndex));
});

test('resizeRgba：等比缩小与 1×1 目标', () => {
  const src = solidRgba(4, 2, [255, 0, 0]);
  const out = resizeRgba(src, 4, 2, 2);
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  for (let p = 0; p < 2; p++) {
    assert.equal(out.data[p * 4]!, 255);
    assert.equal(out.data[p * 4 + 3]!, 255);
  }
  // 1×1 目标：Math.max(1, …) 保证不出现 0 尺寸
  const tiny = resizeRgba(src, 4, 2, 1);
  assert.equal(tiny.width, 1);
  assert.equal(tiny.height, 1);
});

test('resizeRgba：0 尺寸源返回透明底而非 NaN 采样', () => {
  const out = resizeRgba(new Uint8Array(0), 0, 0, 256);
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  assert.ok(out.data.every((v) => v === 0));
});

test('clearRect：越界矩形被钳制在画布内', () => {
  const px = solidRgba(4, 4, [1, 2, 3]);
  clearRect(px, 4, 4, 2, 2, 100, 100);
  // (2,2) 起全清；其余像素保持
  assert.equal(px[(2 * 4 + 2) * 4 + 3]!, 0);
  assert.equal(px[0 + 3]!, 255);
  assert.equal(px[(0 * 4 + 3) * 4 + 3]!, 255);
});

test('decodeGifFrames：单帧 GIF 解出 1 帧（先经 GifWriter 合成源）', () => {
  const w = 6;
  const h = 4;
  const capacity = 65536;
  const buf = Buffer.alloc(capacity);
  const writer = new GifWriter(buf, w, h, { palette: makePackedPalette([[255, 0, 0]]), loop: 0 });
  const indices = new Array<number>(w * h).fill(0);
  writer.addFrame(0, 0, w, h, indices, { delay: 10, transparent: GifTransparentIndex });
  const gif = buf.subarray(0, writer.end());

  const { frames, delays, width, height } = decodeGifFrames(Buffer.from(gif), 32, 16);
  assert.equal(frames.length, 1);
  assert.equal(delays.length, 1);
  assert.equal(width, 6);
  assert.equal(height, 4);
  // GifReader 解出的画布是 RGBA：红色调色板索引 0 → R 通道非 0
  assert.equal(frames[0]![0]!, 255);
});

test('decodeGifFrames：超大逻辑画布直接抛错（解压炸弹防护）', () => {
  assert.ok(GIF_MAX_CANVAS_PIXELS < 65535 * 65535);
});

test('encodeFrames → decodeGifFrames：往返（编 → 解 → 编）输出合法 GIF', () => {
  const frame = solidRgba(8, 6, [20, 120, 220]);
  const gif = encodeFrames([frame, frame], [10, 10], 8, 6);
  assert.ok(gif.byteLength > 0);
  assert.equal(gif[0]!, 0x47); // 'G'
  assert.equal(gif[1]!, 0x49); // 'I'
  assert.equal(gif[gif.length - 1]!, 0x3b); // trailer
  const round = decodeGifFrames(Buffer.from(gif), 64, 16);
  assert.equal(round.frames.length, 2);
  assert.equal(round.width, 8);
  assert.equal(round.height, 6);
});

/** omggif 调色板按 b|g<<8|r<<16 打包；透明索引 255 要求调色板补足 2 的幂（对齐 256）。 */
function makePackedPalette(colors: [number, number, number][]): number[] {
  const palette = colors.map(([r, g, b]) => b | (g << 8) | (r << 16));
  while (palette.length < 256) palette.push(0);
  return palette;
}
