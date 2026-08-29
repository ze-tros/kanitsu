# Kanitsu

Kanitsu是一款本地优先的跨平台图片管理与查看应用。用户导入文件夹后，应用将图片复制到自己的图包库中，再提供目录浏览、自动整理、封面选择、原图查看和 ZIP 导出。

## 当前状态

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows / Electron | 可构建 Portable | 导入、浏览、整理、查看、导出和缩略图缓存已完成；已提供 Windows x64 单 EXE 构建流水线 |
| Android / Capacitor | 可安装测试 | SAF 导入、原生图库、缩略图、查看器、导出和触摸 UI 已完成 |
| Web | 演示模式 | 使用内存文件系统，主要用于 UI 和核心流程开发 |

已实现的主要能力：

- 多层目录、面包屑、搜索、排序、聚合视图、网格与列表视图。
- 命名规则整理预览、落盘、冲突处理和一键撤销。
- 智能封面、手动固定封面、预览模糊和批量操作。
- 原图查看、缩放、平移、旋转、键盘或触摸导航、缩略图渐进加载。
- 原生快速导入、持久化索引、有界缩略图调度和磁盘缓存。
- ZIP 流式导出，保留目录结构并附带 `index.json`。

## 项目结构

```text
apps/
  web/             Vite / React 入口
  desktop/         Electron 主进程、preload 和打包配置
  mobile/          Capacitor Android 壳与原生插件
packages/
  core/            领域类型、扫描、导入、整理和持久化索引
  fs-adapter/      Web、Electron、Android 文件系统适配器
  organizer/       命名解析与整理规则
  cover-picker/    封面评分
  image-pipeline/  图片处理接口
  ui/              桌面与移动端 React UI
docs/
  开发进度与复盘.md
  Android端设计.md
```

## 开发

要求：Node.js 24 LTS、npm；Android 构建还需要 JDK 和 Android SDK。

```bash
npm install
npm run dev:web
npm run dev:desktop
npm run typecheck
npm test --workspaces --if-present
npm run build:web
npm run build:mobile
```

## Windows Portable

完整的版本准备、CI 触发、产物校验和 GitHub Release 流程见 [Windows Portable 打包与发布指南](docs/Windows-Portable-打包与发布指南.md)。

在 Windows x64 上执行完整发布检查与构建：

```powershell
npm ci
npm run release:portable
```

`release:portable` 会依次执行全工作区类型检查、测试、Web 生产构建、Electron 编译和 Portable 打包。开发中重复打包可使用 `npm run build:portable`。

产物固定位于：

```text
apps/desktop/release/portable/Kanitsu-Portable-<version>-x64.exe
apps/desktop/release/portable/SHA256SUMS.txt
```

构建脚本使用每次唯一的 staging 目录，只在新产物通过文件名、PE 文件头、体积和 SHA-256 检查后才替换上一版。可随时用 `npm run verify:portable` 重新校验。

GitHub Actions 中的 `Windows Portable` 工作流支持手动运行，也会在推送 `v*` tag 时触发。tag 必须与桌面包版本一致，例如版本 `0.1.0` 对应 `v0.1.0`。完成后可从该次 Actions 运行的 Artifacts 下载 EXE 和校验文件。

当前没有 Windows 代码签名证书，因此产物未签名，Windows SmartScreen 可能显示风险提示。本地构建默认关闭 Electron Builder 的 EXE 资源编辑，以兼容未开启符号链接权限的 Windows 环境；启用 Windows 开发者模式后，可设置 `KANITSU_SIGN_AND_EDIT_EXECUTABLE=true` 再构建。

正式 CI 固定使用 Electron 和 electron-builder 的官方 GitHub 发布源。本地网络需要镜像时，可在当前 shell 显式设置 `ELECTRON_MIRROR` 和 `ELECTRON_BUILDER_BINARIES_MIRROR`；镜像配置不应用于生成正式发布产物。

此处的 Portable 指“单 EXE、免安装”。图包库、缩略图缓存和日志仍保存到 Electron `userData` 目录，不会随 EXE 移动。

Android debug APK：

```powershell
cd apps/mobile/android
.\gradlew.bat assembleDebug
```

## 文档

- [产品与架构设计](DESIGN.md)
- [开发进度与复盘](docs/开发进度与复盘.md)
- [Android 平台实现](docs/Android端设计.md)
- [Windows Portable 打包与发布](docs/Windows-Portable-打包与发布指南.md)

文档描述稳定约束和当前状态；具体接口与参数以源码和类型定义为准。
