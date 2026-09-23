// electron-builder afterPack 钩子：把产品图标与版本信息写进 Kanitsu.exe。
//
// 背景：本地打包默认 KANITSU_SIGN_AND_EDIT_EXECUTABLE=false（winCodeSign 在无
// 开发者模式/管理员权限的 Windows 上解压失败，见发布文档 §5），electron-builder
// 会整体跳过 exe 资源编辑，安装器与便携版里的 exe 都是 Electron 默认图标，
// 快捷方式/任务栏/卸载列表随之全错。这里用 rcedit 直接补上资源编辑，
// 不依赖 winCodeSign；CI 上资源编辑开启时会再编辑一次，结果一致，无害。
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function locateRcedit() {
  // rcedit v5 的 exports 不暴露 package.json，改从 JS 入口向上找 bin 目录。
  const mainPath = require.resolve("rcedit");
  let dir = path.dirname(mainPath);
  for (let i = 0; i < 4; i++) {
    const name = process.arch === "x64" ? "rcedit-x64.exe" : "rcedit.exe";
    const candidate = path.join(dir, "bin", name);
    if (require("node:fs").existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("rcedit binary not found (expected node_modules/rcedit/bin/rcedit-*.exe)");
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  if (process.platform !== "win32") {
    // rcedit 二进制只能在 Windows 上运行（CI 的交叉打包不走本钩子路径）。
    console.warn("[afterPack] 跳过 exe 资源编辑：rcedit 仅支持在 Windows 上运行。");
    return;
  }

  const appInfo = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const iconPath = path.resolve(__dirname, "../../../assets/kanitsu-icon.ico");
  const rceditPath = locateRcedit();

  // 与 electron-builder 自身 signAndEditExecutable 的编辑项对齐
  // （应用无 author 字段，LegalCopyright 维持缺省）。
  const args = [
    exePath,
    "--set-icon", iconPath,
    "--set-version-string", "ProductName", appInfo.productName,
    "--set-version-string", "FileDescription", appInfo.description || appInfo.productName,
    "--set-version-string", "OriginalFilename", path.basename(exePath),
    "--set-file-version", appInfo.version,
    "--set-product-version", appInfo.version,
  ];

  console.log(`> rcedit（写入图标与版本信息）: ${exePath}`);
  const result = spawnSync(rceditPath, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`rcedit failed: ${result.error ?? `exit code ${result.status}`}`);
  }
};
