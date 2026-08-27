# 全能看图王

全能看图王（Kanitu）是一款本地优先的跨平台图片管理与查看应用。用户导入文件夹后，应用将图片复制到自己的图包库中，再提供目录浏览、自动整理、封面选择、原图查看和 ZIP 导出。

## 当前状态

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows / Electron | 可开发运行 | 导入、浏览、整理、查看、导出和缩略图缓存已完成；安装包与签名仍需发布验证 |
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

要求：Node.js、npm；Android 构建还需要 JDK 和 Android SDK。

```bash
npm install
npm run dev:web
npm run dev:desktop
npm run typecheck
npm test --workspaces --if-present
npm run build:web
npm run build:mobile
```

桌面安装包：

```bash
npm run pack -w @kanitu/desktop
```

Android debug APK：

```powershell
cd apps/mobile/android
.\gradlew.bat assembleDebug
```

## 文档

- [产品与架构设计](DESIGN.md)
- [开发进度与复盘](docs/开发进度与复盘.md)
- [Android 平台实现](docs/Android端设计.md)

文档描述稳定约束和当前状态；具体接口与参数以源码和类型定义为准。
