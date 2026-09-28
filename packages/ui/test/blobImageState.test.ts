import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { blobImageResourceKey, blurPreviewIdentity, blobImagePhase } from '../src/BlobImage';

describe('BlobImage 缓存键契约', () => {
  const fileRef = { id: 'img:Pack/p001.jpg', mtime: 100, size: 2048 };

  test('重命名 / 移动（id 变化）换键：缓存只会 miss，不会误命中旧条目', () => {
    const renamed = { ...fileRef, id: 'img:Pack/p002.jpg' };
    assert.notEqual(
      blobImageResourceKey(fileRef, true, 512),
      blobImageResourceKey(renamed, true, 512),
    );
    assert.notEqual(blurPreviewIdentity(fileRef), blurPreviewIdentity(renamed));
  });

  test('同 relPath 内容替换（mtime/size 变化）换键', () => {
    const replaced = { ...fileRef, mtime: 200, size: 4096 };
    assert.notEqual(blobImageResourceKey(fileRef, true, 512), blobImageResourceKey(replaced, true, 512));
    assert.notEqual(blurPreviewIdentity(fileRef), blurPreviewIdentity(replaced));
  });

  test('缩略图与全图、不同缩略图尺寸的键互不相同', () => {
    const full = blobImageResourceKey(fileRef, false, 512);
    const thumb = blobImageResourceKey(fileRef, true, 512);
    const thumbLarge = blobImageResourceKey(fileRef, true, 1024);
    assert.notEqual(full, thumb);
    assert.notEqual(thumb, thumbLarge);
  });

  test('同一文件身份的键稳定（重复构造值相同）', () => {
    assert.equal(blobImageResourceKey(fileRef, true, 512), blobImageResourceKey({ ...fileRef }, true, 512));
    assert.equal(blurPreviewIdentity(fileRef), blurPreviewIdentity({ ...fileRef }));
  });

  test('mtime/size 缺省时键仍稳定且与显式值可区分', () => {
    const noMeta = { id: 'img:x.jpg', mtime: undefined, size: undefined };
    assert.equal(blobImageResourceKey(noMeta, true, 512), blobImageResourceKey({ ...noMeta }, true, 512));
    assert.notEqual(blobImageResourceKey(noMeta, true, 512), blobImageResourceKey({ ...noMeta, mtime: 1 }, true, 512));
  });
});

describe('BlobImage 三态机', () => {
  const key = 'img:a.jpg\u00001\u0000100\u0000thumb-512';
  const loaded = { key, url: 'blob:x', degraded: false };

  test('交付成功 → image；键不匹配（切图后旧状态）→ skeleton', () => {
    assert.equal(blobImagePhase(loaded, null, key), 'image');
    assert.equal(blobImagePhase(loaded, null, 'other-key'), 'skeleton');
  });

  test('失败记录命中当前资源 → failed；成功交付后失败态清除回 image', () => {
    assert.equal(blobImagePhase(null, key, key), 'failed');
    // 成功交付即清失败态（BlobImage 的 commit 逻辑）：loaded 命中优先于失败态。
    assert.equal(blobImagePhase(loaded, key, key), 'image');
  });

  test('初始（无交付、无失败）→ skeleton', () => {
    assert.equal(blobImagePhase(null, null, key), 'skeleton');
  });
});
