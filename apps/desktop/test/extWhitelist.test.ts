// 常量多处副本的一致性守卫：桌面主进程受 tsc rootDir 限制无法跨包引用，
// RAW/HEIF 扩展名白名单在 electron/rawDecoder.ts 独立维护一份；Java 侧
// SafSource / ZipExportService 又各有一份 IMAGE_EXT。这里把「electron 副本 ↔
// core 规范来源」以及「两份 Java 副本 ↔ core 三集合并集」都钉进测试，漂移立刻
// 可见（Java 侧无法单测运行时行为，直接对源码文本做解析比对）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEIF_IMAGE_EXT as CORE_HEIF, RAW_IMAGE_EXT as CORE_RAW } from '../../../packages/core/src/path';
import { HEIF_IMAGE_EXT as DESKTOP_HEIF, RAW_IMAGE_EXT as DESKTOP_RAW } from '../electron/rawDecoder';

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

/** 从本测试文件向上找仓库根（apps/ 与 packages/ 同级的目录）。 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'apps')) && existsSync(join(dir, 'packages'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('未找到仓库根目录');
}

/** 从 Java 源码提取 `IMAGE_EXT = new HashSet<>(Arrays.asList(...))` 里的全部字面量。 */
function parseJavaImageExt(javaPath: string): Set<string> {
  const src = readFileSync(javaPath, 'utf8');
  const m = src.match(/IMAGE_EXT\s*=\s*new HashSet<>\(Arrays\.asList\(([\s\S]*?)\)\)/);
  if (!m) throw new Error(`未在 ${javaPath} 中找到 IMAGE_EXT 定义`);
  const out = new Set<string>();
  for (const literal of m[1].matchAll(/"([^"]+)"/g)) out.add(literal[1]);
  return out;
}

// core 的 SUPPORTED_IMAGE_EXT 未导出：普通格式这 8 项与 Java 副本的注释口径一致。
const COMMON_IMAGE_EXT = ['jpg', 'jpe', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif'];

describe('扩展名白名单副本一致性', () => {
  test('electron/rawDecoder 的 RAW 白名单与 core/path.ts 完全一致', () => {
    assert.ok(setEquals(CORE_RAW, DESKTOP_RAW), `RAW 副本漂移：core=${[...CORE_RAW].sort()} desktop=${[...DESKTOP_RAW].sort()}`);
  });

  test('electron/rawDecoder 的 HEIF 白名单与 core/path.ts 完全一致', () => {
    assert.ok(setEquals(CORE_HEIF, DESKTOP_HEIF), `HEIF 副本漂移：core=${[...CORE_HEIF].sort()} desktop=${[...DESKTOP_HEIF].sort()}`);
  });

  const root = repoRoot();
  const javaSources = [
    join(root, 'apps/mobile/android/app/src/main/java/com/kanitsu/viewer/kanitsu/SafSource.java'),
    join(root, 'apps/mobile/android/app/src/main/java/com/kanitsu/viewer/kanitsu/ZipExportService.java'),
  ];
  const expected = new Set<string>([...COMMON_IMAGE_EXT, ...CORE_RAW, ...CORE_HEIF]);

  for (const javaPath of javaSources) {
    const label = javaPath.includes('SafSource') ? 'SafSource' : 'ZipExportService';
    test(`Java ${label}.java 的 IMAGE_EXT 与 core 白名单并集完全一致`, () => {
      const actual = parseJavaImageExt(javaPath);
      const missing = [...expected].filter((e) => !actual.has(e));
      const extra = [...actual].filter((e) => !expected.has(e));
      const drift: string[] = [];
      if (missing.length) drift.push(`Java 缺少：${missing.join(', ')}`);
      if (extra.length) drift.push(`Java 多出：${extra.join(', ')}`);
      assert.ok(missing.length === 0 && extra.length === 0, `白名单副本漂移——${drift.join('；')}`);
    });
  }
});
