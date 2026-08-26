# Android 端设计（v0.1）

> 目标：在不改动共享 UI / Core 的前提下，为「全能看图王」接入 Android 平台能力，完成
> SAF 导入、应用图包库、缩略图、原图查看、zip 导出与 APK/AAB 分发。本文与 DESIGN.md
> 的「平台抽象层」对齐，是 docs/开发进度与复盘.md 建议顺序中「Android SAF 导入 / Android zip 导出」的落地方案。

---

## 1. 目标与范围

| 项 | 内容 |
|---|---|
| 平台 | Android 9（API 28）+，Capacitor 6（当前 @capacitor/android 6.2.1） |
| 复用 | 共享 React UI（packages/ui）、Core 服务（packages/core）、平台接口（packages/fs-adapter） |
| 新增 | Android 桥接插件（SAF / 图包库 / 缩略图 / 导出）+ AndroidImportSourcePicker / AndroidLibraryStore |
| 不改 | LibraryBrowser、Viewer、Organize、CoverPicker、Core 的导入/整理/扫描/封面/删除逻辑 |
| 交付 | 可安装 APK，能「SAF 选源 → 复制 → 浏览 → 缩略图 → 原图查看 → zip 导出」 |

**非目标（本期）**：HEIC/TIFF/RAW、WebDAV 同步、云备份。

> 已确认：动画 GIF 缩略图进入本期范围（见 §9.2）。

---

## 2. 结论摘要

| 决策项 | 选择 | 理由 |
|---|---|---|
| 壳 | Capacitor 6 + 自定义本地插件 | 与现有 Electron 桥接同构，共享 UI 100% 复用 |
| 选源 | SAF ACTION_OPEN_DOCUMENT_TREE | 无需存储权限，仅导入期间持有授权 |
| 图包库 | context.getExternalFilesDir(null)/albums/ | 应用私有外部目录，无需权限，卸载即清 |
| 缩略图 | Java 原生生成（ImageDecoder/BitmapFactory）+ 磁盘缓存 + 优先级队列 | WebView 无法跑 sharp；避免整图过桥 |
| 原图查看 | Capacitor.convertFileSrc（本地 HTTP 流式） | WebView 直接 img 加载，不复制大 Buffer |
| 导出 | SAF ACTION_CREATE_DOCUMENT + ZipOutputStream 流式写 | 用户指定位置，内存安全 |
| 索引 | WebView IndexedDB（createIdbPersistentIndex） | 与 Electron 同构，Android 分支打开 |
| 大目录导入 | 原生整树复制（快路径，直接实现） | 避免大文件 base64 往返 JS；SAF→albums 全原生 |

---

## 3. 总体思路：把 Android 当作第三个「平台壳」

现有架构已经把「平台相关能力」收敛到两个接口：

- ImportSourcePicker：选源、列子项、读源文件、释放授权。
- LibraryStore：应用图包库的读写、移动、删除、缩略图、原图 URL、zip 导出。

因此 Android 接入 = 实现这两个接口 + 一个 Capacitor 桥，其余全部复用：

    UI（共享，packages/ui）
       └─ LibraryBrowser / Viewer / Organize / CoverPicker
              │
    Core（共享，packages/core）
       └─ importFolder / scanLibrary / loadOrScan / organize / remove / pickCover / log
              │
    FS Adapter（新增 android.ts）
       └─ AndroidImportSourcePicker / AndroidLibraryStore
              │
    Capacitor 桥（apps/mobile 本地插件 + 生成的 android/）
       └─ SAF 导入 / albums 库 / 缩略图 / convertFileSrc / zip 导出
              │
    Android 系统
       └─ SAF ContentResolver / java.io / ImageDecoder / ZipOutputStream

---

## 4. 工程结构

    apps/mobile/
    ├─ capacitor.config.ts         # appId com.kanitu.viewer，webDir ../web/dist
    ├─ package.json                # 已有 @capacitor/*；增加本地插件依赖
    ├─ android/                    # npx cap add android 生成（提交到仓库）
    │  └─ app/src/main/java/com/kanitu/viewer/
    │     ├─ MainActivity.java
    │     └─ kanitu/               # 本地插件实现（可直接放进 app 工程）
    │        ├─ KanituPlugin.java         # @CapacitorPlugin(name="Kanitu")
    │        ├─ SafSourceBridge.java      # SAF 遍历 / 读文件 / 释放授权
    │        ├─ AlbumLibraryBridge.java   # albums 库 CRUD / 移动 / 删除
    │        ├─ ThumbnailService.java     # ImageDecoder 缩略图 + 磁盘缓存 + 优先级队列
    │        └─ ZipExportService.java     # SAF 创建文件 + ZipOutputStream 流式导出
    └─ src/                        # 可选：Capacitor 侧仅复用 web/dist，无需独立入口
    packages/fs-adapter/src/
    ├─ android.ts                  # KanituAndroidBridge 类型 + 两个适配器实现
    └─ index.ts                    # export * from './android'
    apps/web/src/App.tsx           # 增加 android 平台分支

已确认：插件 Java 类直接写进生成的 android/app 工程（com.kanitu.viewer.kanitu 包），不另建独立插件包；
设计上仍以第 5 节同一份桥契约为准。

---

## 5. 平台桥接契约

### 5.1 TypeScript 侧（packages/fs-adapter/src/android.ts）

与 electron.ts 的 KanituDesktopBridge 保持同构，便于 App.tsx 用同一套选择逻辑：

    export interface AndroidFsEntry {
      id: string;          // 源文件：DocumentFile documentId；库文件：绝对路径
      name: string;
      kind: 'folder' | 'file';
      size?: number;
      mtime?: number;
      width?: number;
      height?: number;
    }

    export interface AndroidThumbnailStats {
      queuedByPriority: number[];
      inFlight: number;
      diskFiles: number;
      diskBytes: number;
    }

    export interface KanituAndroidBridge {
      platform: 'android';
      version: string;

      // ---- SAF 源（仅导入期间持有授权）----
      pickSourceFolder(): Promise<AndroidFsEntry | null>;          // ACTION_OPEN_DOCUMENT_TREE
      listSourceChildren(folder: AndroidFsEntry): Promise<AndroidFsEntry[]>;
      readSourceBlob(file: AndroidFsEntry): Promise<Uint8Array>;
      releaseSource(): Promise<void>;                               // releasePersistableUriPermission

      // ---- 原生整树复制（快路径；v1 可缺省走桥接复制）----
      importSourceTree(source: AndroidFsEntry, targetTopName: string): Promise<{
        copied: number; skipped: number;
        skippedFiles: { path: string; reason: 'no-extension' | 'unsupported-format' }[];
      }>;

      // ---- 应用图包库（albums/）----
      getLibraryRoot(): Promise<AndroidFsEntry>;
      ensureLibraryRoot(): Promise<AndroidFsEntry>;
      createLibraryFolder(parent: AndroidFsEntry, name: string): Promise<AndroidFsEntry>;
      createTopLibraryFolder(name: string): Promise<AndroidFsEntry>;
      writeLibraryBlob(folder: AndroidFsEntry, name: string, data: Uint8Array): Promise<AndroidFsEntry>;
      listLibraryChildren(folder: AndroidFsEntry): Promise<AndroidFsEntry[]>;
      readLibraryBlob(file: AndroidFsEntry): Promise<Uint8Array>;
      readLibraryThumbnail(file: AndroidFsEntry, maxSize: number, priority?: number): Promise<Uint8Array>;
      moveLibraryEntry(entry: AndroidFsEntry, toFolder: AndroidFsEntry, newName?: string): Promise<AndroidFsEntry>;
      removeLibraryEntry(entry: AndroidFsEntry): Promise<void>;
      getLibraryFingerprint(): Promise<string>;

      // ---- 原图查看 / 导出 / 调试 ----
      getViewerUrl(file: AndroidFsEntry): Promise<string>;
      exportZip(targetRelPath: string): Promise<{ canceled: boolean; outputPath?: string; totalImages?: number; exportedCount?: number }>;
      onExportProgress(callback: (p: { done: number; total: number }) => void): () => void;
      getThumbnailStats(): Promise<AndroidThumbnailStats>;
      clearCaches(): Promise<void>;
      setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): Promise<void>;
      readLogs(maxLines?: number): Promise<string[]>;
    }

    declare global {
      interface Window { kanituAndroid?: KanituAndroidBridge; }
    }

### 5.2 Java 侧（KanituPlugin）

- @CapacitorPlugin(name = "Kanitu")，方法名与 TS 一一对应（PluginMethod）。
- 长任务（导入/导出/缩略图）在 ExecutorService / 后台线程执行，PluginCall 不在主线程等待。
- 进度用 Capacitor 事件：notifyListeners("importProgress" | "exportProgress", data)，TS 侧 addListener 订阅。

### 5.3 字节过桥说明

Capacitor JS↔Java 传二进制会序列化（base64/typed-array 往返，约 +33% 内存与 CPU）。设计原则：
小图（缩略图）可过桥；原图导入不走 JS 中转（见 7.3）。所有读原图路径都落到本地 HTTP URL（第 10 节）
或原生内部复制，避免把完整大图搬进 WebView 内存。

---

## 6. 存储布局与权限

### 6.1 目录

    context.getExternalFilesDir(null)/      # /storage/emulated/0/Android/data/com.kanitu.viewer/files/
    ├─ albums/            # 应用图包库根（LibraryRoot），卸载即清
    └─ cache/
       ├─ thumbcache/     # 缩略图磁盘缓存（键规则同 Electron）
       └─ export/         # zip 打包 staging（可选，能流式到 SAF 则不需要）

- albums 即 LibraryStore.getLibraryRoot()；relPath 语义与 Electron 完全一致。
- getExternalFilesDir 为应用私有，无需任何存储权限，Android 11+ 其他应用无法访问。

### 6.2 权限（Manifest）

只保留运行必需的：

    <application android:hardwareAccelerated="true" ...>
      <!-- 不声明 READ_MEDIA_IMAGES / READ_EXTERNAL_STORAGE / MANAGE_EXTERNAL_STORAGE -->
    </application>

- SAF 选源 / 导出创建文件均为系统 UI 授权，不落 Manifest 权限。
- 不申请存储权限、不持久化源目录授权（仅导入期间 takePersistableUriPermission，结束释放）。

---

## 7. SAF 导入设计

### 7.1 选源

    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                  | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
    startActivityForResult(intent, REQ_PICK_TREE);

onActivityResult 拿到 treeUri 后 takePersistableUriPermission 并保存为当前导入会话字段；
releaseSource() 调用 releasePersistableUriPermission 并置空。会话级字段与 Electron
主进程 source grant 的生命周期一致，正好对应 ImportSourcePicker.release?()。

### 7.2 遍历与读文件

- 用 DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, treeDocumentId) + ContentResolver.query，
  投影 COLUMN_DOCUMENT_ID / DISPLAY_NAME / MIME_TYPE / SIZE / LAST_MODIFIED。
- MIME_TYPE_DIR（vnd.android.document/directory）为文件夹，其余按扩展名交给 Core 过滤。
- 读文件：openInputStream(DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId))。
- AndroidFsEntry.id 用 documentId（树内相对 ID），Java 端存 treeUri 会话字段即可重建完整 URI。

### 7.3 复制路径（已确认：直接上原生快路径）

路径 B（原生整树复制，正式实现）：
- Java 直接：遍历源树 → 过滤扩展名 → 在 albums/<顶层名> 建目录 → openInputStream(sourceUri) → Files.copy。
- 顶层重名加 (2)；单文件失败不中断并记录 skippedFiles/errors；进度通过 importProgress 事件上报。
- JS 只拿结果；Core 的 importFolder 增加快路径：若 store.importSourceTree?() 存在则调用，否则回落路径 A。

路径 A（桥接复制，仅作真机异常兜底）：
- AndroidImportSourcePicker.readBlob → Uint8Array → Blob；AndroidLibraryStore.writeBlob → 桥回 Java 写文件。
- 优点：完全复用 packages/core/src/import.ts 的 importFolder；缺点：每图字节过 JS、慢且内存峰值高。

快路径类型签名放入 LibraryStore 可选方法（不影响其他平台）；实现顺序为 A0 骨架后直接实现原生快路径。

---

## 8. 图包库（AndroidLibraryStore）

复用 electron.ts 适配器的结构，逐方法映射到 KanituAndroidBridge：

| LibraryStore 方法 | Java 实现 |
|---|---|
| getLibraryRoot / ensureLibraryRoot | 确保 albums/ 存在并返回 AndroidFsEntry |
| createFolder / createTopFolder | File.mkdirs，顶层重名加 (2) |
| writeBlob | new FileOutputStream 写 Uint8Array（桥接复制路径） |
| listChildren | 列 File[]，文件夹优先、按名排序；文件附带 size/mtime |
| readBlob | Files.readAllBytes（仅整理/导出等少量场景） |
| readThumbnail | 走第 9 节缩略图服务 |
| getViewerUrl | TS 侧 Capacitor.convertFileSrc(file.id)（绝对路径） |
| move / remove | File.renameTo / 递归删除 |
| zipLibrary | 走第 11 节 |
| getLibraryFingerprint | 顶层条目 kind:name 拼接哈希（与 Memory 实现同构） |

路径安全：Java 侧所有 File 操作前统一 assertInside(albumsRoot, file)（getCanonicalPath 前缀校验），
防止整理规则/重命名注入 .. 逃逸图包库。

---

## 9. 缩略图管线

### 9.1 总体

    原图文件(albums)
      → ThumbnailService（优先级队列）
         decode → 等比缩放 ≤maxSize → JPEG q80
      → 磁盘缓存 cache/thumbcache/<sha1>.jpg（键 = relPath+mtime+size+尺寸+版本）
      → 桥回 JS（Uint8Array → Blob → objectURL）
      → 渲染端 thumbnailCache LRU（复用 packages/ui/src/thumbnailCache.ts）

### 9.2 生成

- 优先 ImageDecoder（API 28+，即 minSdk 28；支持 JPEG/PNG/WebP/GIF/HEIF 解码），失败回退 BitmapFactory。
- ImageDecoder 设置 setTargetSampleSize / setTargetSize 直接降采样，避免整图进内存。
- GIF：生成可动缩略图——解码逐帧（ImageDecoder/AnimatedImageDrawable 或 Movie 兜底）→ 降采样 → 抽帧/自适应调色板 → 用轻量 GIF 编码器（如 square/gifencoder）重编码为可动小图；ROM 无法逐帧时回退静态首帧。

### 9.3 队列与缓存

- 复刻 Electron 的优先级语义：P0 可见 > P1 当前目录 > P2 子文件夹/封面 > P3 全库预热。
- Java 侧用一个有界 ExecutorService（2~4 线程）+ 按优先级分桶的 PriorityBlockingQueue；可见请求插队。
- 磁盘缓存上限（如 512MB~1GB）按 mtime 淘汰最旧；失败文件黑名单避免反复解码。
- readLibraryThumbnail(file, maxSize, priority) 返回 Uint8Array；命中磁盘缓存时直接返回。

说明：Android 不用 sharp/libvips，改用系统 ImageDecoder；渲染端优先级、LRU、objectURL 池完全复用，无需新写 UI 缓存。

---

## 10. 原图查看

- 查看器（共享 Viewer）已用 img src=store.getViewerUrl(file) 显示原图。
- Android 的 getViewerUrl 在 TS 侧实现：Capacitor.convertFileSrc(file.id)（file.id 为绝对路径），
  返回 http://localhost/_capacitor_file_/...，由 WebView 本地服务流式读文件，不复制大 Buffer。
- releaseViewerUrl 为 no-op（本地 URL 无需释放）。
- 依赖：packages/fs-adapter 将 @capacitor/core 列为 peerDependencies（optional），仅 android.ts 运行期 import，不影响 Electron/Web 构建。

---

## 11. zip 导出

- 用户点击导出 → UI 调 store.zipLibrary(targetRelPath, onProgress)（Core 不变）。
- AndroidLibraryStore.zipLibrary 调桥 exportZip：
  1. ACTION_CREATE_DOCUMENT（MIME application/zip，建议名 <图包名>.zip）。
  2. ZipOutputStream(openOutputStream(uri)) 流式打包，STORE（level 0），与 Electron 一致。
  3. 递归 albums/<target>，保留目录结构；target='' 导出整库、target='MangaA' 时包一层 MangaA/...。
  4. 附加 index.json（复用 packages/fs-adapter/src/exportIndex.ts 的 schema；Java 侧内联同一结构）。
  5. 进度通过 exportProgress 事件上报；用户取消 SAF 对话框返回 canceled: true。
- zipLibrary 返回 { kind: 'file', outputPath: uri }（与 Electron outputPath 语义一致，仅展示用）。

---

## 12. 索引持久化

- WebView 支持 IndexedDB，直接复用 createIdbPersistentIndex（当前仅 Electron 分支开启）。
- apps/web/src/App.tsx 的持久化判断改为：

    const persistent =
      window.kanituDesktop?.platform === 'electron' ||
      window.kanituAndroid?.platform === 'android';

- 风险：WebView 存储可能被系统回收，需 loadOrScan 的「指纹不符→全量重扫」兜底（已具备）。

---

## 13. 与现有代码的接入点（实施清单）

| 文件 | 动作 |
|---|---|
| packages/fs-adapter/src/android.ts | 新增：桥类型 + AndroidImportSourcePicker + AndroidLibraryStore |
| packages/fs-adapter/src/index.ts | export * from './android' |
| packages/fs-adapter/src/types.ts | 可选：LibraryStore.importSourceTree?() 快路径（7.3） |
| packages/core/src/import.ts | 可选：importFolder 优先走 importSourceTree，否则回落桥接复制 |
| apps/web/src/App.tsx | 增加 kanituAndroid 分支 + Android 索引持久化 |
| apps/mobile/android/app/src/main/java/com/kanitu/viewer/kanitu/* | 新增：Java 插件类（SAF / 库 / 缩略图 / 导出），直接写入 android 工程 |
| apps/mobile/capacitor.config.ts | 注册本地插件；确认 webDir、android 配置 |
| apps/mobile/android/ | npx cap add android 生成；Manifest/主题/签名配置 |
| package.json | 增加移动端脚本：build:mobile（web 构建 + cap sync + gradle） |

---

## 14. 性能预算（沿用 DESIGN.md，Android 中端机）

| 指标 | 目标 | 说明 |
|---|---|---|
| 1000 文件夹目录树当前层 | < 300ms | 懒加载不变 |
| 1 万图网格滚动 | 虚拟化后不卡（复用现有窗口化） | WebView 渲染复用 |
| 缩略图出图 | 磁盘命中 < 30ms，生成 < 150ms | ImageDecoder 降采样 |
| 大图打开 | < 200ms（预取后） | convertFileSrc 流式 |
| 导入 1000 张 | 原生快路径优先，后台线程 + 进度 | 避免 JS 字节往返 |
| 内存 | 索引 < 100MB（不含原图缓存） | WebView LRU 复用 |

---

## 15. 分阶段实施与验收

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| A0 骨架 | npx cap add android、插件类写入 android/app、android.ts 桥、App.tsx 分支 | APK 启动进入空库；设置页显示「Android 模式」 |
| A1 SAF 导入（原生快路径） | SAF 选源 + 原生整树复制 importSourceTree + readThumbnail | SAF 选目录 → 原生复制 → 树/网格/缩略图可浏览；进度/取消/重名 |
| A2 图包库补全 | list/read/move/remove/create/getViewerUrl | 重命名、删除、新建子文件夹、整理落盘、原图查看可用 |
| A3 缩略图工程化 | ImageDecoder + 磁盘缓存 + 优先级队列 + 动画 GIF 缩略图 | 1000+ 图滚动流畅，重启缓存命中，GIF 可动缩略图 |
| A4 zip 导出 | SAF 创建文件 + ZipOutputStream + index.json | 导出 zip 可解压、目录结构正确、进度准确 |
| A5 分发 | 签名 APK/AAB、minSdk 28、图标/启动图 | 安装即用，卸载后 albums 清除 |

---

## 16. 风险与待确认

### 16.1 主要风险

1. SAF 遍历大目录慢：DocumentFile 逐项递归偏慢。缓解：DocumentsContract 批量 query；原生后台线程 + 进度；路径 B 快路径。
2. 桥接字节往返内存：大图过 JS 有 +33% 序列化开销。缓解：原图走本地 URL、缩略图只传 ≤512px、导入走原生快路径。
3. 动画 GIF 缩略图：要「可动且小」需要逐帧解码 + 重编码，Android 无内置 GIF 编码器。缓解：轻量 gifencoder 依赖 + 抽帧/调色板；ROM 无法逐帧时回退静态首帧。
4. WebView IndexedDB 被回收：缓存索引可能失效。缓解：指纹校验 + 全量重扫兜底（已具备）。
5. HEIF/格式兼容：不同 ROM 解码能力不一。缓解：失败黑名单 + 占位；正式格式范围仍按 DESIGN.md 七种。

### 16.2 已确认（本轮拍板）

| 问题 | 结论 |
|---|---|
| 导入实现顺序 | 直接上原生快路径（路径 B）；路径 A 仅作真机异常兜底 |
| 动画 GIF 缩略图 | 需要可动缩略图（进入 A3；无法逐帧时回退静态首帧） |
| 本地插件形态 | 直接写进生成的 android/app 工程，不建独立插件包 |
| minSdk | 28（Android 9） |
| zip 内容 | 图片目录结构 + index.json，与 Electron 现状一致 |

---

## 17. 一句话结论

Android 端本质上是「把 Electron 主进程的 fs/缩略图/导出能力，换成 SAF + 应用外部目录 + ImageDecoder + SAF 导出」，
共享 UI 与 Core 零改动；建议按 A0 骨架 → A1 SAF 原生导入 → A2 库 → A3 缩略图（含动画 GIF）→ A4 导出 → A5 分发推进。
