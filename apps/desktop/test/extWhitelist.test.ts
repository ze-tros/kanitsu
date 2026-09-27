// 常量多处副本的一致性守卫：桌面主进程受 tsc rootDir 限制无法跨包引用，
// RAW/HEIF 扩展名白名单在 electron/rawDecoder.ts 独立维护一份（Java 侧还有
// SafSource / ZipExportService 两份副本，无 node 测试环境，靠 CI grep 把关）。
// 这里把「electron 副本 ↔ core 规范来源」钉进测试，漂移立刻可见。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HEIF_IMAGE_EXT as CORE_HEIF, RAW_IMAGE_EXT as CORE_RAW } from '../../../packages/core/src/path';
import { HEIF_IMAGE_EXT as DESKTOP_HEIF, RAW_IMAGE_EXT as DESKTOP_RAW } from '../electron/rawDecoder';

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

describe('扩展名白名单副本一致性', () => {
  test('electron/rawDecoder 的 RAW 白名单与 core/path.ts 完全一致', () => {
    assert.ok(setEquals(CORE_RAW, DESKTOP_RAW), `RAW 副本漂移：core=${[...CORE_RAW].sort()} desktop=${[...DESKTOP_RAW].sort()}`);
  });

  test('electron/rawDecoder 的 HEIF 白名单与 core/path.ts 完全一致', () => {
    assert.ok(setEquals(CORE_HEIF, DESKTOP_HEIF), `HEIF 副本漂移：core=${[...CORE_HEIF].sort()} desktop=${[...DESKTOP_HEIF].sort()}`);
  });
});
