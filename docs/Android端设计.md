# Android 平台实现

> 更新于 2026-08-27。本文描述当前实现；公共产品和架构约束见 [`DESIGN.md`](DESIGN.md)。

## 1. 平台结构

Android 端由共享 Web 应用、Android 适配器和 Capacitor 原生插件组成：

```text
MobileApp / MobileViewer
          │
core + organizer + cover-picker
          │
AndroidImportSourcePicker / AndroidLibraryStore
          │
Capacitor Kanitsu plugin
  ├─ SafSource
  ├─ AlbumLibrary
  ├─ ThumbnailService
  └─ ZipExportService
```

移动端使用独立触摸组件树，但复用扫描、索引、整理、封面、条目操作和缩略图缓存等共享逻辑。

## 2. 工程位置

| 路径 | 职责 |
|---|---|
| `apps/mobile/capacitor.config.ts` | 应用 ID、名称、Web 资源目录和 Android 配置 |
| `apps/mobile/android/` | Gradle 工程和 Android 资源 |
| `KanitsuPlugin.java` | Capacitor 方法、后台线程、任务取消、进度事件和调试接口 |
| `SafSource.java` | SAF 目录访问与原生整树导入 |
| `AlbumLibrary.java` | 应用图库 CRUD、路径校验和指纹 |
| `ThumbnailService.java` | 缩略图解码、GIF、队列与磁盘缓存 |
| `ZipExportService.java` | SAF 目标文件与流式 ZIP 导出 |
| `packages/fs-adapter/src/android.ts` | TypeScript bridge 与两个平台适配器 |
| `packages/ui/src/mobile/` | 触摸优先 UI 和查看器 |

完整 bridge 类型以 `packages/fs-adapter/src/android.ts` 为准，不在文档中复制接口定义。

## 3. 启动与平台检测

`apps/web/src/App.tsx` 按以下顺序检测平台：

1. Electron preload 标记。
2. 已注册的 Android bridge。
3. Capacitor `getPlatform()`。
4. Android WebView 注入的 `androidBridge`。

检测到 Android 后，应用先调用 `initAndroidBridge()`，完成注册后再创建 `AndroidImportSourcePicker`、`AndroidLibraryStore` 和持久化索引，最后渲染 `MobileApp`。这可避免启动时误入 Web 内存演示模式。

## 4. 存储与权限

图库位于：

```text
context.getExternalFilesDir(null)/albums/
```

该目录属于应用，无需广泛存储权限。`AlbumLibrary` 对移动、删除、读取和写入执行 canonical path 边界检查，防止操作逃出图库根目录。

外部源目录和导出位置通过 SAF 由用户选择。Manifest 不申请 `READ_MEDIA_IMAGES`、`READ_EXTERNAL_STORAGE` 或 `MANAGE_EXTERNAL_STORAGE`；`INTERNET` 用于 Capacitor 本地 Web 运行机制，不代表图片联网传输。

## 5. 导入

```text
ACTION_OPEN_DOCUMENT_TREE
  → 保存当前 SAF tree URI
  → 后台遍历 DocumentsContract
  → 过滤支持的图片扩展名
  → 原生流式复制到 albums/<目录名>
  → 发送 importProgress
  → 返回计数、跳过项和错误
  → 刷新 IndexedDB 索引
```

行为约束：

- 顶层重名自动使用 `名称 (2)`、`名称 (3)`。
- 单文件失败不终止整个导入。
- 任务由 token 关联 `AtomicBoolean`，UI 可调用 `cancelTask`。
- 取消后保留已经复制的文件。
- JS 字节桥接路径只作为兼容回退，正常导入使用原生整树复制。

## 6. 缩略图

`KanitsuPlugin` 使用固定大小线程池处理请求，`ThumbnailService` 再通过信号量限制并发解码数量。缓存键包含文件路径、修改时间、大小、目标尺寸和实现版本。

处理策略：

- 静态图片使用 Android 解码器降采样后输出小图。
- 小 GIF 可直接复用；限定大小内的 GIF 生成动画缩略图；过大 GIF 回退静态首帧，避免 OOM。
- 缓存命中直接返回磁盘内容。
- 渲染端限制全局并发和预取规模；原生 `priority` 参数目前为后续优先队列预留。
- 设置页可查看队列、磁盘文件数和容量，并清理缓存。
- RAW 文件（CR2/CR3/NEF/NRW/ARW/DNG/RAF/ORF/RW2/PEF/SRW）不进 `ThumbnailService`（平台解码器不支持）：`AndroidLibraryStore.readThumbnail` 检出 RAW 后在 WebView Worker 内用 libraw-wasm 提取相机内嵌预览（无预览时 halfSize 完整解码兜底）。原文件通过 `getViewerUrl` 的本地 HTTP 服务流式 fetch，不占用 base64 字节桥；解码任务渲染端串行执行。
- HEIF/HEIC（HEIC/HEIF/HIF）缩略图原生可解（API 28+ 的 ImageDecoder/BitmapFactory 自带 HEIF 支持），走 `ThumbnailService` 正常管线，零特殊分支。

## 7. 原图查看器

`getViewerUrl` 使用 Capacitor 本地服务的实际 origin 与 `_capacitor_file_` 路径生成 URL，并对文件路径进行编码。原图由 WebView `<img>` 直接读取，不经 JS bridge 复制。

HEIF/HEIC 原图 WebView 解不了（Chromium 无 HEVC 软解）：`getViewerUrl` 检出 HEIF 后改走 `ensureViewerDerivative`，由新增的 `DerivativeService` 原生解码（ImageDecoder 优先，自动应用容器/EXIF 方向；BitmapFactory 回退路径补 EXIF 旋转）转 JPEG 落盘缓存（`getExternalFilesDir/cache/derivatives`，长边 ≤6000，LRU 上限 1GB，单路串行防 OOM），再把派生 JPEG 的 `_capacitor_file_` URL 给渲染端。缓存目录在图库外，不进扫描；设置页「清理缓存」同时清空。

移动查看器的加载约束：

- 每次打开创建独立会话，避免沿用上次查看状态。
- 静止时只挂载当前页；拖动或翻页时临时挂载相邻页。
- 目标缩略图与原图绝对重叠并共享尺寸。
- 原图单向淡入，完全覆盖后隐藏缩略图，避免黑帧和亮度闪烁。
- 打开/关闭动画与横向翻页动画分离。
- 页面缓存和胶片条均有窗口上限。

支持左右翻页、下滑关闭、长图纵向平移、捏合缩放、双击缩放、旋转、信息面板和系统返回键。

## 8. ZIP 导出

```text
ACTION_CREATE_DOCUMENT
  → 用户选择目标 URI（多选导出时以 archiveName 为建议文件名）
  → ZipOutputStream 流式遍历图库目录（多选导出时按 includeRelPaths 过滤）
  → 保留相对目录结构
  → 写入 index.json
  → 发送 exportProgress
```

导出支持取消。返回值包含取消状态、目标 URI、总图片数和已导出数量。

多选导出复用同一个 `exportZip` 方法：`includeRelPaths` 只作为遍历结果的过滤集合，条目仍由遍历图库根得到，传入路径不直接拼接成文件，不会越出图库根。

## 9. 任务与生命周期

- 导入、缩略图和导出在后台线程执行，主线程只负责 Activity 结果和 UI 交互。
- 导入与导出使用 token 注册取消标志，结束后必须注销。
- Capacitor 事件用于传递导入和导出进度。
- WebView IndexedDB 保存图库快照；启动时通过图库指纹决定是否重扫。
- 应用被系统回收后，原生图库仍在；索引可由完整扫描恢复。

## 10. 构建与安装

从仓库根目录一键构建 Web、同步 Capacitor 并生成 debug APK：

```bash
npm run build:android
```

APK 路径：

```text
apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

覆盖安装：

```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

## 11. 发布前检查

- 配置 release keystore，确认密钥保管和 CI 注入方式。
- 更新 `versionCode` / `versionName`，生成并验证 AAB 与 release APK。
- 验证升级安装、卸载数据行为、启动图标和系统主题。
- 覆盖 Android 9 及以上、中低端设备、大图库、横屏和后台恢复。
- 回归 SAF 授权、取消、空间不足、导出中断和异常格式。
