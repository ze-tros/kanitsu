# 全能看图王

本地优先的跨平台看图应用。

文档：
- [设计草案](DESIGN.md)
- [开发进度与复盘](docs/开发进度与复盘.md)

## 当前状态

- ✅ Electron 真实导入链路
- ✅ 多层级目录树（折叠/展开）
- ✅ 子文件夹卡片 + 智能封面
- ✅ 直属图片网格 + 缩略图
- ✅ 导入报告
- ✅ Electron 大图预览与缩略图内存安全处理
- ✅ 命名整理虚拟预览
- ✅ 命名整理落盘 + 一键撤销
- ✅ zip 导出（Electron 保存对话框流式打包 / Web-Memory 下载）
- 🚧 Android SAF 导入
- 🚧 安装包打包

## 目录
- apps/web：Vite + React 演示
- apps/desktop：Electron 主进程/preload + dev 脚本
- apps/mobile：Capacitor Android 壳（后续）
- packages/core：类型、路径、扫描、导入服务
- packages/fs-adapter：文件系统抽象与内存实现/Electron 实现
- packages/organizer：按命名自动整理
- packages/cover-picker：智能封面
- packages/image-pipeline：缩略图管线接口
- packages/ui：共享 UI 组件

## 开发
```bash
npm install
npm run dev:web     # Web 演示
npm run dev:desktop # Electron 开发
npm run typecheck   # 类型检查
```
