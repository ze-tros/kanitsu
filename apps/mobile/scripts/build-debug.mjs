import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const androidDir = resolve(import.meta.dirname, '../android');
const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const wrapperPath = resolve(androidDir, wrapper);

if (!existsSync(wrapperPath)) {
  console.error(`Gradle wrapper not found: ${wrapperPath}`);
  process.exit(1);
}

const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : wrapperPath;
// 必须传绝对路径：设置了 NoDefaultCurrentDirectoryInExePath 的环境下，cmd 不会
// 从当前目录解析 gradlew.bat，裸文件名会直接报"不是内部或外部命令"。
const args = process.platform === 'win32'
  ? ['/d', '/c', wrapperPath, '--no-daemon', 'assembleDebug']
  : ['--no-daemon', 'assembleDebug'];
const result = spawnSync(command, args, { cwd: androidDir, stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status === 0) {
  console.log(`APK: ${resolve(androidDir, 'app/build/outputs/apk/debug/app-debug.apk')}`);
}

process.exit(result.status ?? 1);
