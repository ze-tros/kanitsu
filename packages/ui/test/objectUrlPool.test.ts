import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { acquireObjectUrl, releaseObjectUrl } from '../src/objectUrlPool';

function makeBlob(size: number): Blob {
  return new Blob([new Uint8Array(size)]);
}

describe('objectUrlPool', () => {
  test('同一 Blob 重复 acquire 返回同一 URL，引用计数叠加', () => {
    const blob = makeBlob(10);
    const url1 = acquireObjectUrl(blob);
    const url2 = acquireObjectUrl(blob);
    assert.equal(url1, url2);
    // 释放一次后仍可复用（引用还有一份）。
    releaseObjectUrl(url1);
    const url3 = acquireObjectUrl(blob);
    assert.equal(url3, url1);
    releaseObjectUrl(url2);
    releaseObjectUrl(url3);
  });

  test('引用归零后重新 acquire 仍然复用（池内空闲条目不立即撤销）', () => {
    const blob = makeBlob(10);
    const url = acquireObjectUrl(blob);
    releaseObjectUrl(url);
    const again = acquireObjectUrl(blob);
    assert.equal(again, url, '空闲条目应保留在池里供复用');
    releaseObjectUrl(again);
  });

  test('release 未知的 URL 是安全的 no-op', () => {
    assert.doesNotThrow(() => releaseObjectUrl('blob:unknown'));
  });
});
