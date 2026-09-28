import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { peekPrefetchedOriginal, prefetchOriginal } from '../src/originalPrefetch';

/**
 * 查看器原图预解码池（LRU）。Node 无 Image/URL.createObjectURL：
 * - Image 用「src 赋值即微任务完成解码」的替身，宽高与 decode 成败按 URL 配置；
 * - revokeObjectURL 打补丁计数，验证池子释放 blob: URL 的行为。
 */

interface FakeImage {
  src: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  removed: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  decode(): Promise<void>;
  removeAttribute(name: string): void;
}

type ImageSpec = { w: number; h: number; decodeFail?: boolean; loadFail?: boolean };

function installImageShim(specs: Map<string, ImageSpec>): { created: FakeImage[] } {
  const created: FakeImage[] = [];
  class FakeImage implements FakeImage {
    src = '';
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
    removed = false;
    decodeFailed = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor() {
      created.push(this);
    }

    decode(): Promise<void> {
      const spec = specs.get(this.src);
      return spec?.decodeFail ? Promise.reject(new Error('decode fail')) : Promise.resolve();
    }

    removeAttribute(): void {
      this.removed = true;
    }
  }
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    get: () =>
      class extends FakeImage {
        constructor() {
          super();
          // src 赋值即按配置异步完成「下载 + 解码」。
          queueMicrotask(() => {
            const spec = specs.get(this.src);
            if (spec?.loadFail) {
              this.onerror?.();
              return;
            }
            this.naturalWidth = spec?.w ?? 0;
            this.naturalHeight = spec?.h ?? 0;
            this.complete = true;
            this.onload?.();
          });
        }
      },
  });
  return { created };
}

describe('originalPrefetch（查看器原图预解码池）', () => {
  const realRevoke = URL.revokeObjectURL;
  let revoked: string[] = [];

  beforeEach(() => {
    revoked = [];
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
  });

  afterEach(() => {
    URL.revokeObjectURL = realRevoke;
  });

  test('decode 成功后入池，peek 返回尺寸并刷新 LRU', async () => {
    installImageShim(new Map([['blob:ok-a', { w: 100, h: 50 }]]));
    prefetchOriginal('blob:ok-a', 100, 50);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(peekPrefetchedOriginal('blob:ok-a'), { w: 100, h: 50 });
    assert.equal(revoked.length, 0, '仍在池中的 URL 不会被撤销');
  });

  test('未预取的 URL peek 返回 null', () => {
    installImageShim(new Map());
    assert.equal(peekPrefetchedOriginal('blob:none'), null);
  });

  test('入池后的重复 prefetch 走 LRU touch，不再创建 Image', async () => {
    const { created } = installImageShim(new Map([['blob:dup', { w: 10, h: 10 }]]));
    prefetchOriginal('blob:dup', 10, 10);
    await new Promise((r) => setTimeout(r, 0)); // 等首次解码入池
    prefetchOriginal('blob:dup', 10, 10);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(created.length, 1);
    assert.deepEqual(peekPrefetchedOriginal('blob:dup'), { w: 10, h: 10 });
  });

  test('入池前的重复 prefetch 各自创建 Image，但池内只留一个条目', async () => {
    // 已知行为：解码中的请求不去重（在途窗口极短），后入池者按 URL 覆盖前一个。
    const { created } = installImageShim(new Map([['blob:race', { w: 10, h: 10 }]]));
    prefetchOriginal('blob:race', 10, 10);
    prefetchOriginal('blob:race', 10, 10);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(created.length, 2);
    assert.deepEqual(peekPrefetchedOriginal('blob:race'), { w: 10, h: 10 });
  });

  test('条目数超过上限：最旧的被移除并释放 blob: URL', async () => {
    const specs = new Map<string, ImageSpec>();
    for (let i = 0; i < 17; i++) specs.set(`blob:${i}`, { w: 10, h: 10 });
    const { created } = installImageShim(specs);
    for (let i = 0; i < 17; i++) prefetchOriginal(`blob:${i}`, 10, 10);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(peekPrefetchedOriginal('blob:0'), null, '最旧的条目应被淘汰');
    assert.deepEqual(peekPrefetchedOriginal('blob:16'), { w: 10, h: 10 });
    assert.ok(created[0].removed, '被淘汰的 Image 应移除 src 释放解码位图');
    assert.ok(revoked.includes('blob:0'));
  });

  test('预估值超过字节上限的不入池，且释放 blob: URL', async () => {
    // 20000×12000 × 4B = 960MB > 2×384MB 的入池预检上限。
    installImageShim(new Map([['blob:huge', { w: 20000, h: 12000 }]]));
    prefetchOriginal('blob:huge', 20000, 12000);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(peekPrefetchedOriginal('blob:huge'), null);
    assert.ok(revoked.includes('blob:huge'));
  });

  test('decode 失败：不入池并释放 URL', async () => {
    installImageShim(new Map([['blob:bad', { w: 10, h: 10, decodeFail: true }]]));
    prefetchOriginal('blob:bad', 10, 10);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(peekPrefetchedOriginal('blob:bad'), null);
    assert.ok(revoked.includes('blob:bad'));
  });

  test('字节加载失败（onerror）：不入池并释放 URL', async () => {
    installImageShim(new Map([['blob:err', { w: 10, h: 10, loadFail: true }]]));
    prefetchOriginal('blob:err', 10, 10);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(peekPrefetchedOriginal('blob:err'), null);
    assert.ok(revoked.includes('blob:err'));
  });
});
