import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RAW_IMAGE_EXT, isRawImage } from '../src/formats';
import { resolveRawDecodeOptions, toLibrawSettings } from '../src/options';

test('RAW_IMAGE_EXT 覆盖首期 11 种主流格式', () => {
  for (const ext of ['cr2', 'cr3', 'nef', 'nrw', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw']) {
    assert.ok(RAW_IMAGE_EXT.has(ext), `缺少 ${ext}`);
  }
  assert.equal(RAW_IMAGE_EXT.size, 11);
});

test('isRawImage 按扩展名大小写不敏感判定', () => {
  assert.ok(isRawImage('IMG_0001.CR2'));
  assert.ok(isRawImage('DSC_1234.Nef'));
  assert.ok(isRawImage('a/b/c/photo.arw'));
  assert.ok(isRawImage('no-extension.dng'));
  assert.ok(!isRawImage('IMG_0001.JPG'));
  assert.ok(!isRawImage('photo.png'));
  assert.ok(!isRawImage('cr2.txt'));
  assert.ok(!isRawImage('extensionless'));
  assert.ok(!isRawImage(''));
});

test('resolveRawDecodeOptions 默认值与覆盖', () => {
  assert.deepEqual(resolveRawDecodeOptions(), { useCameraWb: true, outputColor: 1, halfSize: false });
  assert.deepEqual(resolveRawDecodeOptions({ halfSize: true, useCameraWb: false, outputColor: 6 }), {
    useCameraWb: false,
    outputColor: 6,
    halfSize: true,
  });
});

test('toLibrawSettings 固定 8bit 输出并透传归一化选项', () => {
  assert.deepEqual(toLibrawSettings(resolveRawDecodeOptions({ halfSize: true })), {
    useCameraWb: true,
    outputColor: 1,
    outputBps: 8,
    halfSize: true,
  });
});
