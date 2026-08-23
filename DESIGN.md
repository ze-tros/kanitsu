# 全能看图王（暂定名）设计草案 v0.3

> 目标：一个本地优先、以 **PC 安装包** 和 **Android** 为主的看图应用。用户选择图包文件夹后，**复制一份到应用自己的图包目录**；应用只浏览、整理这份副本。支持主流图片格式与 GIF，按路径树浏览、按命名自动整理、智能选择封面、流畅手势看图、导出为 zip。暂不做在线功能，但为未来 WebDAV 等云同步预留接口。

---

## 1. 结论摘要

| 决策项 | 选择 | 理由 |
|---|---|---|
| 总体架构 | 一套 Web 前端 + 多端壳 | PC 安装包（Electron）、Android 共享 90% 以上 UI 与业务代码；Web 仅作为未来可选项 |
| 技术栈 | TypeScript + Vite + React + Zustand + Dexie + Motion/Framer Motion + TanStack Virtual | 生态成熟、虚拟列表与动画方案齐全、便于 Electron/Capacitor 复用 |
| PC 分发 | **Windows 安装包为主**（NSIS/便携版） | 用户以安装包使用；完整文件夹访问、文件关联、右键发送 |
| 图包存储 | Electron 用应用数据目录，Android 用应用外部文件目录 | 应用只管理副本，权限简单；卸载后数据一并清除 |
| 手动添加文件夹 | 选择源文件夹 → 递归扫描 → 复制图片到应用图包目录（保留目录结构） | 复制后源文件夹可删除/卸载，不影响应用 |
| 导出 | 选中图包 → 打包为 **zip** 导出 | 格式通用、便于分享与备份 |
| 图片索引与缓存 | IndexedDB（Dexie）+ 缩略图/封面缓存 | 图片规模 <1 万，无需 SQLite |
| 图片格式 | jpg / jpeg / png / webp / avif / bmp / gif | 主流静态格式 + GIF 动图 |
| 自动整理 | 只处理应用图包目录内的副本；先预览，确认后移动/重命名 | 源文件不在应用内，操作副本可回退、更安全 |
| 智能封面 | 感知哈希 + 清晰度 + 命名规则 + 用户反馈，空闲计算 | 兼顾效果与性能 |
| 在线/同步 | 暂不实现；预留 `SyncProvider` 接口（未来 WebDAV） | 保持本地优先，架构不返工 |
| 隐私 | Local-first，默认不上传任何图片 | 看本地图片的核心信任点 |

> 备选方案：若团队更熟悉 Flutter，可用 Flutter 实现 Android + Windows。但 PC 安装包与 Android 的文件系统权限模型仍要抽象。本文按 Web 技术栈展开。

---

## 2. 需求映射

| 需求 | 设计落点 |
|---|---|
| 打包分发到 PC 与 Android | PC：Windows 安装包为主（Electron）；Android：Capacitor APK/AAB |
| 手动添加文件夹 | 统一“添加图包”入口：选择源文件夹 → 递归扫描 → 复制到应用图包目录（保留子目录结构） |
| 按路径树查看，同路径图片为一个图包，支持多层级 | 应用图包目录树 = 相册树；目录懒加载；面包屑与树侧栏 |
| 根据命名自动整理成树状文件目录 | 文件名解析规则引擎 → 预览整理方案 → 在应用图包目录内移动/重命名副本，可撤销 |
| 智能选择预览图 | 封面评分算法，异步计算并缓存 |
| 多种手势/快捷键，流畅过渡 | 统一交互规范；缩放/翻页手势；键盘映射；共享元素过渡与 FLIP 动画 |
| 看图易用 | 大图查看器、胶片栏、预加载、缩放模式、EXIF 方向修正、GIF 动画播放 |
| 导出图包 | 选中图包/目录 → 打包为 zip 导出，包含整理后的目录结构 |
| 卸载后不保留 | 图包与索引均在应用目录内，随应用卸载清除 |
| 暂不联网，未来云同步 | 当前无任何网络请求；预留 `SyncProvider` 接口便于未来接入 WebDAV |

---

## 3. 总体架构

### 3.1 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                     UI 层（共享 Web 代码）                    │
│  导航 / 目录树 / 网格相册 / 大图查看器 / 整理向导 / 设置        │
│  React + Zustand + TanStack Virtual + Motion(动画)           │
├─────────────────────────────────────────────────────────────┤
│                       应用核心层（共享）                       │
│  ImportService  LibraryService  TreeService                  │
│  OrganizerService  CoverPicker  ViewerController             │
│  ExportService(zip)  ImagePipeline（缩略图 / LQIP / GIF）     │
│  SyncProvider 接口（预留，当前为空实现）                        │
├─────────────────────────────────────────────────────────────┤
│                   平台抽象层（两个接口）                       │
│  ImportSourcePicker：选源文件夹、遍历源、读源文件              │
│  LibraryStore：应用图包目录读写、移动、删除、导出源             │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  Electron    │  Android     │  Web（可选）  │  未来 iOS      │
│  选源：对话框 │  选源：SAF   │  选源：FSA   │  ...           │
│  库：应用目录 │  库：应用目录 │  库：OPFS    │                │
└──────────────┴──────────────┴──────────────┴────────────────┘
```

### 3.2 工程结构（monorepo）

```
kanitu/
├─ apps/
│  ├─ desktop/          # Electron 壳（主）+ Node fs 导入/图包库 + sharp + zip 导出
│  ├─ mobile/           # Capacitor Android 壳 + SAF 导入插件 + zip 导出
│  └─ web/              # Vite + PWA（可选，OPFS 图包库）
├─ packages/
│  ├─ core/             # 状态、仓库、服务、扫描索引、导入任务、导出任务、SyncProvider 接口
│  ├─ fs-adapter/       # ImportSourcePicker 与 LibraryStore 接口及实现
│  ├─ organizer/        # 命名解析、整理规则
│  ├─ cover-picker/     # 智能封面算法
│  ├─ image-pipeline/   # 缩略图、方向修正、LQIP、GIF、预取
│  └─ ui/               # 通用组件、手势、动画
└─ docs/
```

### 3.3 运行模式

- **PC 桌面（Electron，主）**：系统目录对话框或拖入源文件夹，复制到应用数据目录下 `图包/`；支持文件关联（设为默认看图器）、删除/重命名副本、导出 zip。卸载时图包目录随应用一并清除（不保留）。
- **Android（Capacitor，主）**：`ACTION_OPEN_DOCUMENT_TREE` 选择源文件夹，读取后复制到应用外部文件目录 `albums/`；复制完成后不需要持久化源目录授权；导出 zip 到用户指定位置（SAF 创建文件）。卸载时图包目录清除（不保留）。
- **PC Web（PWA，可选）**：通过 File System Access API 选择源文件夹，复制到 OPFS；仅作为轻量预览/降级方案，不作为主要分发形态。

---

## 4. 核心数据模型

### 4.1 类型定义（核心）

```ts
// 应用图包库根目录（平台实现决定实际位置）
interface LibraryRoot {
  id: 'library';
  name: string;                // "图包"
  relPath: '';                 // 库内路径从根开始
}

// 一次“添加图包”导入任务
interface ImportTask {
  id: string;                  // uuid
  sourceFolderName: string;    // 用户选择的源文件夹名
  sourceRef?: FolderRef;       // 仅导入期间使用，完成后不持久化源授权
  targetTopFolder: string;     // 应用图包目录下的目标顶层文件夹名
  status: 'picking' | 'scanning' | 'copying' | 'indexing' | 'done' | 'failed' | 'canceled';
  scannedFileCount: number;
  copiedImageCount: number;
  skippedCount: number;        // 非图片/不支持格式
  errorList: ImportError[];
  createdAt: number;
  finishedAt?: number;
}

// 目录节点：图包目录内一个目录 = 一个图包（相册）
interface FolderNode {
  id: string;                  // 'lib:' + sha1(normalizedRelPath)
  parentId: string | null;
  name: string;
  relPath: string;             // 相对图包根目录，统一 '/' 分隔，根为 ''
  imageCount: number;          // 本目录直属图片数
  childCount: number;          // 子目录数
  coverImageId?: string;       // 智能封面
  etag?: string;               // 增量扫描
}

interface ImageEntry {
  id: string;                  // 'lib:' + sha1(normalizedRelPath + name)
  folderId: string;
  name: string;
  relPath: string;             // 相对图包根目录
  ext: string;                 // jpg/jpeg/png/webp/avif/bmp/gif
  size: number;
  mtime: number;
  width?: number;
  height?: number;
  orientation?: number;
  thumbKey?: string;
}

interface OrganizeRule {
  id: string;
  name: string;
  kind: 'separator' | 'chapter' | 'date' | 'author' | 'regex' | 'commonPrefix';
  config: Record<string, unknown>;
  enabled: boolean;
  priority: number;
}

interface OrganizeBinding {
  imageId: string;
  virtualPath: string;         // 如 "进击的巨人/第01卷/p001.jpg"
  confidence: number;
  materialized: boolean;       // 是否已在图包目录内落盘
}

// 导出 zip 任务
interface ExportTask {
  id: string;
  target: string;              // 图包/目录 relPath，空表示整个库
  status: 'pending' | 'zipping' | 'done' | 'failed';
  outputPath?: string;         // 最终 zip 路径
  totalImageCount: number;
  processedCount: number;
  createdAt: number;
}

// 未来云同步预留接口（当前为空实现）
interface SyncProvider {
  readonly id: string;
  upload(exportZip: Blob, meta: unknown): Promise<void>;
  download(id: string): Promise<Blob>;
}
```

### 4.2 本地库（Dexie/IndexedDB）

| 表 | 内容 |
|---|---|
| `importTasks` | 导入任务、进度、错误列表 |
| `exportTasks` | 导出 zip 任务、进度 |
| `folders` | 图包目录树节点、统计、封面引用 |
| `images` | 图片元数据 |
| `covers` | 封面计算结果与评分明细 |
| `thumbs` | 缩略图 blob、尺寸、生成参数 |
| `organizeRules` | 整理规则 |
| `organizeBindings` | 命名解析映射 |
| `settings` | 手势、快捷键、缩放、排序、外观 |
| `scanLog` | 导入/整理/导出/删除审计日志 |

### 4.3 路径与图包规则

- 应用图包目录树：`图包/顶层图包名/子目录/孙目录`。
- 用户选择的源文件夹会成为顶层图包（可重名自动加序号），其内部子目录结构原样保留。
- **每一个目录节点都是一个“图包”**，展示其直属图片；同时提供“包含子目录”聚合视图（如 `图包/进击的巨人` 可聚合下面所有卷）。
- 目录树懒加载：打开某层才扫描下一层，避免一次遍历大库。
- 路径 ID 使用图包库内相对路径哈希；图片重命名通过扫描比对 `size+mtime` 尽可能识别为同一图片。

---

## 5. 文件系统抽象

应用内有两个平台接口：**导入源选择器** 和 **图包库存储**。

```ts
// 1) 导入源选择器：只负责读取用户选择的源文件夹
interface ImportSourcePicker {
  readonly kind: 'web-fsa' | 'electron' | 'android-saf';

  pickFolder(): Promise<FolderRef>;                          // 系统选择器
  listChildren(folderRef: FolderRef): AsyncGenerator<FsEntry, void, void>;
  readBlob(fileRef: FileRef): Promise<Blob>;
}

// 2) 图包库存储：应用自己的图包目录，只增删改查副本
interface LibraryStore {
  readonly kind: 'web-opfs' | 'electron' | 'android-app-dir';

  ensureLibraryRoot(): Promise<void>;
  createTopFolder(name: string): Promise<FolderRef>;         // 处理重名
  writeBlob(folderRef: FolderRef, name: string, blob: Blob): Promise<void>;
  listChildren(folderRef: FolderRef): AsyncGenerator<FsEntry, void, void>;
  readBlob(fileRef: FileRef): Promise<Blob>;
  move(from: FileRef, toFolderRef: FolderRef, newName?: string): Promise<void>;  // 整理用
  remove(fileRef: FileRef): Promise<void>;

  // 导出 zip：target 为图包/目录 relPath（空为整个库），按目录结构打包
  zipLibrary(targetRelPath: string, onProgress: (p: number) => void): Promise<Blob>;
  watchLibrary?(cb: (e: FsEvent) => void): Unwatch;
}
```

关键实现差异：

| 能力 | Electron（主） | Android（主） | Web/PWA（可选） |
|---|---|---|---|
| 选择源文件夹 | 系统对话框 / 拖拽 | SAF `ACTION_OPEN_DOCUMENT_TREE` | `showDirectoryPicker()` / `webkitdirectory` 降级 |
| 源目录授权 | 仅导入期间有效 | 仅导入期间有效，不持久化 | 仅导入期间有效 |
| 应用图包目录 | `应用数据目录/图包/`（卸载即清） | `应用外部文件目录/albums/`（卸载即清） | OPFS（浏览器站点私有存储） |
| 图包库访问 | Node.js fs | 应用目录直接文件访问 | OPFS API |
| 变更监听 | 可选 chokidar | 无需（应用独占） | 无需（应用独占） |
| 导入大目录 | 快速 | 后台线程 + 进度条 | 流式遍历 + 进度条 |
| 导出 zip | 主进程生成，存用户指定位置 | 打包后经 SAF 写入用户指定位置 | 下载 Blob |

### 5.1 导入复制流程

```
用户点击“添加图包”
  → 系统选择源文件夹
  → 递归遍历源文件夹（流式，边扫边报进度）
  → 过滤扩展名：jpg/jpeg/png/webp/avif/bmp/gif
  → 目标 = 图包目录/<源文件夹名>（重名自动加 (2)）
  → 按源目录相对路径逐文件复制（保留子目录结构）
  → 单文件失败不中断，记录 errorList，完成后可重试
  → 复制完成 → 扫描目标目录建立索引（FolderNode/ImageEntry）
  → 生成缩略图、标记封面待算
```

- **取消与断点**：支持取消；已复制文件保留，重试时按 `size+mtime` 跳过相同文件。
- **只复制图片**：非图片文件默认跳过（可设置“复制所有文件”，但查看器只显示图片）。
- **顶层重名**：`进击的巨人`、`进击的巨人 (2)`，在 UI 中可重命名。

### 5.2 导出 zip

```
用户在目录树选择图包/目录 → 点击“导出”
  → 创建 ExportTask
  → 按图包目录内的相对路径读取图片文件，写入 zip（保留目录结构）
  → 进度：已处理/总图片数
  → Electron：zip 写到用户选择的保存路径（如 图包名.zip）
  → Android：打包到缓存后经 SAF 写入用户指定位置（如 Download/图包名.zip）
  → Web（可选）：触发浏览器下载 Blob
```

- 支持导出单个图包、某个子目录、或整个图包库。
- zip 内目录结构与“整理后的图包目录树”一致。
- 大文件流式写入，避免内存峰值；导出完成后不删除应用内图包。

---

## 6. 根据命名自动整理

### 6.1 设计原则

1. **只处理应用图包目录内的副本**：源文件不在应用内，整理操作（移动/重命名）只作用于图包目录，天然不破坏用户原始文件。
2. **先预览、再落盘、可回退**：整理前显示“原名 → 新路径”对照表；移动时生成 undo manifest，支持一键还原。
3. **规则可解释、可编辑**：每条解析显示命中的规则与置信度。
4. **保守处理**：无法高置信度解析的文件留在原目录/未分类，不强行猜测。

### 6.2 解析流水线

```
原始文件名
  → Unicode 归一化（全角分隔符 → 半角，NFKC）
  → 去除扩展名、清理首尾空白
  → 显式层级分隔符拆分：/ \ ／ ＼ › 》 | 
  → 规则链匹配（按优先级）：
      1. 章节卷规则：series_ch001_p12、第01卷、Vol.3、EP4
      2. 日期规则：2024-01-02_xxx、2024年1月_xxx
      3. 作者标签规则：[作者] 作品名 001
      4. 通用系列-编号规则：作品名_01、作品名 01.jpg
      5. 自定义正则：用户可添加 {series}/{volume}/{page}
      6. 公共前缀聚类：无明显层级时，对目录内文件按公共前缀分组
  → 生成候选虚拟路径
  → 置信度评分
  → UI 展示树状预览
```

### 6.3 内置规则示例

| 输入文件名 | 解析结果（虚拟路径） | 规则 |
|---|---|---|
| `进击的巨人_第01卷_p001.jpg` | `进击的巨人/第01卷/p001.jpg` | 卷规则 |
| `[谏山创] 进击的巨人 01-02.jpg` | `谏山创/进击的巨人/01-02.jpg` | 作者标签 |
| `2024-03-05_旅行_001.jpg` | `2024/03/旅行/001.jpg` | 日期规则 |
| `漫画A／第2话／03.jpg` | `漫画A/第2话/03.jpg` | 显式分隔符 |
| `pic001.jpg`, `pic002.jpg`, `pic003.jpg` | `未分类/picxxx`（低置信度提示） | 保守处理 |

### 6.4 预览与落盘

- **预览**：解析结果写入 `organizeBindings`，UI 展示整理后树状结构对照表，用户可逐项修改。
- **落盘**：
  1. 预览变更清单（移动/重命名，均在图包目录内）。
  2. 冲突检测：目标已存在时，默认跳过并报告；可选 `xxx (2)` 或覆盖（需确认）。
  3. 执行移动并写 undo manifest，支持一键还原。
  4. 完成触发增量扫描。
- **注意**：整理只改变应用图包目录内的文件位置，不触碰用户原始文件夹。

---

## 7. 智能选择预览图（封面）

### 7.1 候选范围

- 目录直属图片。
- GIF 参与封面计算时使用首帧静态图；网格中 GIF 缩略图可选择显示动画或首帧。
- 若目录只有子目录无图片：递归采用“最优质子目录封面”作为本目录封面，并在封面角标显示来源。

### 7.2 评分模型

```
score = 0.50 * representativeness   # 目录内代表度
      + 0.20 * imageQuality         # 分辨率、清晰度、无坏图
      + 0.10 * recency              # 较新的文件轻微加权
      + 0.10 * namingPrior          # cover/front/001 等命名先验
      + 0.10 * userFeedback         # 用户设为封面的长期偏好
```

- **representativeness**：
  - 对目录内图片抽样（例如最多 64 张）计算 8×8 或 16×16 dHash/pHash。
  - 取与聚类中心最接近的 medoid；如果图片颜色/构图差异巨大，则优先清晰度项。
- **imageQuality**：
  - 分辨率：短边 ≥ 300 得基础分；越高边际收益越低。
  - 清晰度：灰度图 Laplacian 方差，剔除全黑、全白、纯色、严重模糊。
  - 宽高比：接近 3:4、1:1、4:3 的常见封面比例加权，超长条截图降权。
- **namingPrior**：
  - 命中 `cover`、`folder`、`front`、`preview`、`thumbnail`、`000`、`001` 等加分。
- **userFeedback**：
  - 用户手动设封面 = 固定封面，优先级最高。
  - 用户经常点击某张图作为入口，可在重算时略微加分。

### 7.3 计算策略

1. 新添加/扫描完成后的目录，标记 `coverDirty=1`。
2. 浏览器空闲时，在 Web Worker / Electron 后台线程中计算。
3. 缩略图复用 ImagePipeline；感知哈希与清晰度只读取低分辨率缩略图。
4. 结果持久化到 `covers` 表，UI 先用主色占位，计算完成后渐变显示。
5. 目录内容变化时只重算受影响目录，不整库重算。

---

## 8. 看图交互设计

### 8.1 页面结构

```
┌────────────┬──────────────────────────────┬─────────────┐
│  目录树     │  面包屑：漫画库 / 进击的巨人     │  排序/视图   │
│  ▸ 漫画库   │  ┌────┐ ┌────┐ ┌────┐         │  缩略图尺寸  │
│    ▸ 巨人   │  │封面│ │封面│ │封面│  ...      │  包含子目录  │
│      ▸ 第1卷│  └────┘ └────┘ └────┘         │             │
│    ▸ 写真   │  虚拟网格（惰性加载 + 虚拟滚动）  │             │
│             ├──────────────────────────────┤             │
│             │ 胶片栏：← [当前] →             │             │
└────────────┴──────────────────────────────┴─────────────┘
```

大图查看器：
- 进入时从点击缩略图共享元素过渡放大。
- 顶部/底部 UI 自动隐藏，单击切换。
- 左右预加载当前图前后各 2~3 张。

### 8.2 键盘快捷键（PC）

| 键 | 动作 |
|---|---|
| `←` / `→` | 上一张 / 下一张 |
| `↑` / `↓` | 上/下滚动浏览（网格模式）或上一行/下一行 |
| `Space` / `Shift+Space` | 下一张 / 上一张 |
| `Home` / `End` | 第一张 / 最后一张 |
| `+` / `-` / `0` | 放大 / 缩小 / 适应窗口 |
| `1` / `2` | 100% / 适应宽度 |
| `F` / `Esc` | 全屏 / 退出全屏或关闭查看器 |
| `Ctrl+F` | 搜索当前目录 |
| `Delete` | 删除（需二次确认，桌面端） |
| `Ctrl+C` | 复制图片 / 复制路径 |
| `R` | 顺时针旋转（仅视图，可选写回） |
| `I` | 显示/隐藏 EXIF 信息 |

### 8.3 触摸手势（Android / 触屏）

| 手势 | 动作 |
|---|---|
| 单击 | 显示/隐藏工具栏 |
| 双击 | 在 100% 与适应窗口之间切换 |
| 单指左右滑动 | 上一张 / 下一张 |
| 单指上下滑动 | 查看器内：关闭（向下超过阈值）；网格内：滚动 |
| 双指捏合 | 0.5x ~ 8x 连续缩放 |
| 双指拖动 | 缩放后平移 |
| 长按 | 上下文菜单（设封面、整理、分享、详情） |
| 边缘滑动 | 打开/收起目录树 |

### 8.4 鼠标

- 单击：显示/隐藏工具栏。
- 双击：缩放切换。
- 滚轮：缩放（查看器）或滚动（网格）。
- `Ctrl+滚轮`：网格缩略图尺寸调节。
- 拖拽：缩放后的图片平移；网格空白处框选（可选）。

### 8.5 过渡动画

| 场景 | 方案 | 性能要求 |
|---|---|---|
| 缩略图 → 大图 | 共享元素（FLIP）：记录缩略图 rect，spring 缩放 + 圆角收敛 | 16ms 内启动，掉帧降级为淡入淡出 |
| 上一张/下一张 | 相邻预解码 + 短距离滑动/交叉淡化 | 滑动跟手，松手回弹或翻页 |
| 目录切换 | 网格 FLIP 重排；旧内容淡出，新内容渐进显示 | 虚拟列表只动画可见项 |
| 图片加载 | 主色占位 → LQIP → 全图 blur-up | 无白屏闪烁 |
| 封面计算完成 | 封面缩略图 crossfade 替换 | 后台空闲计算 |
| 系统弱能/用户设置 | `prefers-reduced-motion` 时全部降级为简单淡入 | 可访问性 |

---

## 9. 图片管线与性能

### 9.1 缩略图管线

```
原图 Blob
  → decodeImage（按需/Worker/OffscreenCanvas，桌面可接 sharp）
  → EXIF orientation 修正
  → 最长边 512px，WebP q=78（GIF 额外生成首帧 WebP 缩略图）
  → 生成 32px LQIP + 主色
  → 写入 IndexedDB 缓存，内存 LRU 两阶段
```

- 网格优先加载可见行，其次预取下一屏。
- 查看器预取当前 ±2 张原图或 2560px 预览。
- GIF 查看器使用 `<img>` 直接播放原图动画；网格默认静态首帧，可切换为动画缩略图（数量大时关闭）。
- 缓存上限按设备可用存储动态控制（例如总缓存 ≤ 2GB 或可用空间 10%，取较小值），LRU 淘汰。

### 9.2 性能预算

| 指标 | 目标 |
|---|---|
| 目录树打开 1 万文件夹 | < 300ms 渲染当前层 |
| 网格 1 万图滚动 | 虚拟化后无卡顿，首屏 < 1s |
| 大图打开（已预取） | < 120ms |
| 翻页动画 | 稳定 60fps（中端手机） |
| 内存占用 | 1 万图索引 < 100MB（不含原图缓存） |

---

## 10. 权限与隐私

- **默认完全本地**：图片、缩略图、索引均在本机，无账号、无上传。
- **暂不联网**：当前版本不包含任何网络请求；未来 WebDAV 同步作为独立模块接入，需用户显式配置。
- Electron：图包保存在应用数据目录，卸载即清除（不保留用户数据）。
- Android 仅申请：
  - SAF 目录树授权（用户主动选择源文件夹，仅导入期间使用）。
  - 导出 zip 时 SAF 创建文件授权（用户主动选择保存位置）。
  - 不申请 `READ_MEDIA_IMAGES`、不申请 `MANAGE_EXTERNAL_STORAGE`。
  - 图包保存在应用外部文件目录，卸载即清除。
- 删除/移动/重命名等破坏性操作只作用于图包副本，仍需确认、日志和可撤销路径。

---

## 11. 分发矩阵

| 平台 | 产物 | 打包工具 | 优先级 |
|---|---|---|---|
| Windows | NSIS 安装包 / 便携版 | electron-builder | **主** |
| Android | APK（内测）+ AAB（商店） | Capacitor + Android Studio 签名 | **主** |
| Web/PWA | 静态站点（可选降级） | Vite + vite-plugin-pwa | 可选 |
| macOS/Linux | 可选后续 | electron-builder | 后续 |
| Android 最低版本 | 建议 Android 9（API 28） | 兼容 SAF 与 WebView 性能 | - |

---

## 12. 测试策略

- **organizer 单测**：覆盖常见命名模式、边界重复、低置信度、Unicode 全角。
- **cover-picker 单测**：构造小样本图片集，验证纯色/模糊图不被选中。
- **fs-adapter 契约测试**：内存假实现 + Electron/Android 实现在真实设备上跑同一套用例。
- **导入测试**：复制中断/重试、重名顶层文件夹、跳过非图片、单文件失败不中断。
- **导出测试**：zip 内目录结构正确、可解压、进度准确、取消无坏文件。
- **UI 测试**：Playwright 跑关键路径（添加图包 → 复制进度 → 树 → 网格 → 看图 → 整理 → 导出）。
- **真机测试清单**：Android SAF 选择源目录、复制到应用目录、导出 zip、1000+ 文件夹、翻页手势、内存与 ANR。

---

## 13. 里程碑建议

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| M0 骨架 | monorepo、状态模型、内存假 FS、树 + 网格 + 基础查看器 | 演示数据可浏览 |
| M1 PC 导入 | Electron 选源 + 复制到应用图包目录 + 浏览 | Windows 安装包可“选择图包 → 复制 → 浏览” |
| M2 Android 导入 | Android SAF 选源 + 复制到应用图包目录 + 浏览 | APK 可导入并浏览 |
| M3 图包树 | 多层级目录、懒加载、面包屑、包含子目录聚合 | 大目录流畅展开 |
| M4 自动整理 | 规则引擎、预览、图包内移动/重命名、撤销 | 常见命名一键成树 |
| M5 智能封面 | 评分算法、后台计算、手动固定封面、GIF 首帧 | 封面质量人工抽检通过 |
| M6 看图体验 | 完整手势/快捷键、共享元素过渡、GIF 播放、预取、性能优化 | 中端 Android 60fps |
| M7 导出与分发 | 导出 zip、Windows 签名安装包、Android 签名 APK/AAB | 安装即用、导出可解压 |

---

## 14. 风险与待确认问题

### 14.1 主要风险

1. **Android 复制大目录耗时**：SAF 遍历 + 逐文件复制较慢。缓解：后台线程、进度条、取消/重试、按 `size+mtime` 断点续传。
2. **zip 导出大图包**：大量图片打包耗时。缓解：流式写入、进度与取消、后台线程。
3. **AVIF/HEIC 等格式兼容**：不同 Android WebView 解码能力不一致。缓解：缩略图生成失败时显示占位并标记；桌面端可接 sharp/libheif。
4. **自动整理误判**：规则过强会乱分目录。缓解：预览确认、置信度阈值、undo。
5. **GIF 内存占用**：大量动画缩略图会提高内存。缓解：默认静态首帧，动画缩略图可关闭，查看器按需加载原图。

### 14.2 已确认

1. 选择图包后**复制一份到应用图包目录**，之后只管理副本。
2. 整理只处理应用图包列表内的文件。
3. 图片规模一般 **< 1 万**。
4. 支持**主流图片格式 + GIF**。
5. PC 端**主要为 Windows 安装包**；Web/PWA 仅作可选降级。
6. 导出方式为 **zip 打包**。
7. 卸载后**不保留**图包数据。
8. 暂不联网；未来可能以 **WebDAV 等方式云同步**（当前预留接口）。

### 14.3 仍需确认

1. 是否需要重命名顶层图包、删除图包、查看导入历史？（建议 M2/M3 一并做）
2. 导出 zip 时是否需要在 zip 内包含“封面/元数据”等额外文件，还是只包含图片目录结构？
3. 未来 WebDAV 同步是“整库同步”还是“单个图包上传/下载”？

---

## 15. 下一步执行

1. 初始化 monorepo 与基础组件。
2. 先用“内存假文件系统”跑通完整 UI 与导入/整理/导出交互。
3. 接入 Electron 作为第一个真实平台（选源、复制、图包库、zip 导出）。
4. 实现 organizer 规则引擎（纯函数，可独立单测）。
5. 接入 Android（SAF 导入、应用目录图包库、zip 导出），补齐分发。

---

## 16. 当前实现状态与复盘

当前项目已完成：

- Electron 真实导入链路（选源 → 复制 → 扫描 → 浏览）
- 多层级目录树（折叠/展开）
- 子文件夹卡片 + 智能封面
- 直属图片网格 + 缩略图
- 导入报告（跳过文件与原因）
- Electron 大图预览与缩略图内存安全处理
- 命名整理虚拟预览
- 命名整理落盘（移动/重命名 + 冲突检测）+ 一键撤销（undo manifest）
- zip 导出（Electron 主进程 `archiver` 流式写到保存对话框路径；Web/Memory 用内置 STORE zip 编码器下载）
- 导出 zip 附带 `index.json`（目录树 + 图片元数据）
- 持久化索引（IndexedDB 缓存，启动增量加载，避免全量重扫）
- 删除相册（删除选中目录及其全部下级，二次确认）
- 原图无损查看（Electron `kanitu-file` 协议流式读取原始文件，替代 2560px 预览；缩放/平移/旋转 + 相邻预取）
- 键盘导航（上/下切换同级目录、Esc 返回上级）
- 面包屑导航（根到当前目录可点击路径）

详细的进度、问题复盘与下一阶段计划见：

📄 [docs/开发进度与复盘.md](docs/开发进度与复盘.md)
