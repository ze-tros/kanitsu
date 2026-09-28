import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearBlurPreviewCaches, getBlurPreviewBlob, peekBlurPreviewBlob } from '../src/blurPreview';

/**
 * 隐私模糊预览的降级契约（Node 无 canvas/createImageBitmap/IndexedDB）：
 * - 生成路径失败时 resolve 源 Blob 本身（调用方据此走 CSS blur 兜底，隐私不降级）；
 * - 失败键进入负缓存，洪峰下同一坏键不再反复尝试生成；
 * - clearBlurPreviewCaches 清空负缓存（设置页「清除缓存」后应允许重试）。
 * 用可计数的 createImageBitmap 替身观察「尝试生成」的次数。
 */

describe('blurPreview 降级与负缓存', () => {
  const realCreateImageBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  let attempts = 0;

  beforeEach(() => {
    attempts = 0;
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = () => {
      attempts++;
      return Promise.reject(new Error('no canvas in test env'));
    };
    clearBlurPreviewCaches();
  });

  afterEach(() => {
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = realCreateImageBitmap;
  });

  function makeBlob(size: number): Blob {
    return new Blob([new Uint8Array(size)]);
  }

  test('peek 未生成时返回 null', () => {
    assert.equal(peekBlurPreviewBlob('identity'), null);
  });

  test('生成失败时 resolve 源 Blob 本身（降级不抛错）', async () => {
    const source = makeBlob(64);
    const out = await getBlurPreviewBlob(source, 'identity-a');
    assert.equal(out, source, '失败应返回源 Blob，调用方据 out === source 走 CSS 兜底');
    assert.ok(attempts >= 1, '失败前应至少尝试过一次生成');
  });

  test('失败键进入负缓存：同一身份的重复请求不再尝试生成', async () => {
    const source = makeBlob(64);
    await getBlurPreviewBlob(source, 'identity-b');
    const first = attempts;
    const out = await getBlurPreviewBlob(source, 'identity-b');
    assert.equal(out, source);
    assert.equal(attempts, first, '负缓存命中时不重复尝试生成');
  });

  test('不同身份各自尝试生成（负缓存按身份隔离）', async () => {
    const source = makeBlob(32);
    await getBlurPreviewBlob(source, 'identity-c1');
    await getBlurPreviewBlob(source, 'identity-c2');
    assert.ok(attempts >= 2, '不同身份不应共享负缓存');
  });

  test('clearBlurPreviewCaches 后负缓存被清空，允许重新生成', async () => {
    const source = makeBlob(32);
    await getBlurPreviewBlob(source, 'identity-d');
    clearBlurPreviewCaches();
    await getBlurPreviewBlob(source, 'identity-d');
    assert.ok(attempts >= 2, '清除缓存后应重新尝试生成');
    assert.equal(peekBlurPreviewBlob('identity-d'), null, '失败不进结果缓存');
  });
});
