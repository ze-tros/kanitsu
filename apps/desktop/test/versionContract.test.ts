// 版本单一来源的强校验（进入 npm test --workspaces，即 CI 门禁的一部分）：
// 发布 tag 与 desktop 包 version 一一对应（仓库发布约定），Android versionName /
// versionCode 与 Web 构建注入的 KANITSU_VERSION 都从它派生。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url)); // apps/desktop/test
const desktopDir = dirname(testDir); // apps/desktop

function repoRoot(): string {
  let dir = desktopDir;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'apps')) && existsSync(join(dir, 'packages'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('未找到仓库根目录');
}

const root = repoRoot();
const desktopPackage = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as { version?: string };
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };

/** 按 build.gradle 的派生公式复算 versionCode（maj*10000 + min*100 + patch）。 */
function deriveVersionCode(version: string): number {
  const segments = version.split('.');
  return (
    Number(segments[0]) * 10000 +
    (segments.length > 1 ? Number(segments[1]) * 100 : 0) +
    (segments.length > 2 ? Number(segments[2]) : 0)
  );
}

describe('版本单一来源契约（tag ↔ desktop ↔ Android/Web 派生）', () => {
  test('根 package.json 与 desktop 包版本一致', () => {
    assert.ok(desktopPackage.version, 'desktop 包缺 version 字段');
    assert.equal(rootPackage.version, desktopPackage.version, 'root 与 desktop 版本漂移');
  });

  test('build.gradle 引用的 desktop/package.json 路径真实存在', () => {
    const gradlePath = join(root, 'apps/mobile/android/app/build.gradle');
    const gradle = readFileSync(gradlePath, 'utf8');
    const m = gradle.match(/desktopPackageFile\s*=\s*file\('([^']+)'\)/);
    assert.ok(m, 'build.gradle 未找到 desktopPackageFile 定义');
    // Groovy file() 相对于 app 模块目录解析。
    const resolved = resolve(dirname(gradlePath), m[1]);
    assert.ok(
      existsSync(resolved),
      `build.gradle 里的 package.json 路径解析不到文件：${m[1]} → ${resolved}`,
    );
    assert.equal(resolved, join(desktopDir, 'package.json'), 'build.gradle 应指向 apps/desktop/package.json');
  });

  test('build.gradle 的派生公式与 desktop 版本一致', () => {
    const gradle = readFileSync(join(root, 'apps/mobile/android/app/build.gradle'), 'utf8');
    // 派生公式若被改动，测试里的复算会失真：公式形态变化时这里直接失败提醒同步。
    assert.match(gradle, /versionCode derivedVersionCode/);
    assert.match(gradle, /versionName desktopVersion/);
    assert.match(gradle, /\* 10000\)/, 'versionCode 公式（maj*10000 + min*100 + patch）已被改动，请同步本测试');
    const version = desktopPackage.version ?? '0.0.0';
    const code = deriveVersionCode(version);
    assert.ok(Number.isInteger(code) && code > 0, `versionCode 派生结果非法：${version} → ${code}`);
    // semver 预发布段（如 0.3.3-beta.1）会让 Groovy 的 toInteger() 抛错并退回 0.0.0：
    // desktop version 必须是纯三段数字，发布约定依赖这一点。
    assert.match(version, /^\d+\.\d+\.\d+$/, 'desktop 版本应为纯三段 semver（Android 派生不支持预发布段）');
  });

  test('vite 构建仍注入 KANITSU_VERSION（移动端设置页版本来源）', () => {
    const viteConfig = readFileSync(join(root, 'apps/web/vite.config.ts'), 'utf8');
    assert.match(viteConfig, /KANITSU_VERSION/, 'vite.config.ts 不再注入 KANITSU_VERSION，移动端设置页将缺失版本号');
    assert.match(viteConfig, /desktop\/package\.json/, 'vite.config.ts 的版本读取源应指向 apps/desktop/package.json');
  });
});
