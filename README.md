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
- ✅ Electron 大图预览与缩略图内存安全处理（原图经 kanitu-file 协议流式读取）
- ✅ 命名整理虚拟预览
- ✅ 命名整理落盘 + 一键撤销
- ✅ 原图无损查看（缩放/平移/旋转 + 相邻预取）
- ✅ zip 导出（Electron 保存对话框流式打包 / Web-Memory 下载）
- ✅ 导出 zip 附带 index.json 索引（目录树 + 图片元数据）
- ✅ 持久化索引（IndexedDB 缓存，启动增量加载）
- ✅ 删除相册（删除选中目录及其全部下级）
- ✅ 看图页键盘导航（↑/↓ 切同级目录并展示其首张图、←/→ 上一/下一张、Esc 关闭看图；目录树/网格无快捷键）
- ✅ 面包屑导航
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
