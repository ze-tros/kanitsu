# 全能看图王 UI 重设计方案

> ✅ **已落地**（2026-08-24，commit `234a4a6`）：本方案的 Tailwind v4 + daisyUI v5 接入、深浅色主题、侧边栏/顶栏/卡片/沉浸式查看器、骨架屏、预览模糊、toast、空态等均已实现到应用源码，后续功能（右键菜单、设置页等）在此基础上继续演进。本文现作为设计稿与验收标准留档，配套演示见 `docs/ui-demo.html`（需联网加载 CDN）。

---

## 0. 组件库选型：daisyUI + Tailwind

**结论：采用 daisyUI（基于 Tailwind CSS 的组件库）来补齐通用 UI，定制部分自己写。**

### 为什么选 daisyUI

- 与项目匹配：**React + Vite + TypeScript**，daisyUI 是纯 CSS 组件类，无 React 运行时依赖，接入简单。
- **主题能力强**：内置多套主题（含深/浅色），通过 `data-theme` 一条属性即可切换，天然支持“跟随系统 + 手动切换 + 记忆”。
- **覆盖我们的需求**：按钮 / 卡片 / 弹窗(Modal) / 抽屉(Drawer) / 侧边导航(Navbar) / 菜单(Menu) / 面包屑(Breadcrumbs) / 加载(Skeleton) / 提示(Toast) / 空态(Hero/Empty) 等现成组件类。
- 轻量、可定制：基于 Tailwind 工具类，配色与视觉可用 CSS 变量深度覆盖。

### 版本与技术栈

- **Tailwind CSS v4**（构建期接入，`@tailwindcss/vite` 或 PostCSS）。
- **daisyUI v5**（作为 Tailwind 插件启用）。
- 主题：默认跟随系统（`prefers-color-scheme`），手动切换写入 `localStorage`，根元素设置 `data-theme="dark"|"light"`。

### 组件分工

| 部分 | 用谁 |
|---|---|
| 按钮 / 菜单 / 面包屑 / 树 / 弹窗 / 抽屉 / toast / skeleton / 空态 | daisyUI 组件类 |
| 侧边栏布局 / 顶栏布局 | daisyUI（Navbar / Drawer / Menu）+ 少量自定义 |
| 图片网格 / 文件夹卡片 / hover 封面 / 懒加载 | 自定义（Tailwind 工具类 + 少量 CSS） |
| 查看器 / Lightbox / 胶片条 / 缩放平移旋转 | 自定义 |
| 深浅色主题令牌 | 自定义 CSS 变量 + daisyUI 主题 |

### 风险与注意

- 需要接入 Tailwind 构建（增加配置），`npm run dev:web` 会先启动 Vite + Tailwind，属正常变化。
- daisyUI 的 Modal/Drawer 默认依赖 CSS 技巧（如 `:focus`/checkbox），在 React 里建议配合 React state 控制开合，避免纯 CSS hack。

---

## 1. 目标

把当前“内部测试 demo”观感升级为**产品级看图应用**：

- 视觉更有层次、更精致（留白、圆角、阴影、反差）。
- 深/浅色跟随系统，并支持手动切换。
- 布局更清晰：侧边栏做导航，顶部做操作，主区做内容。
- 查看器沉浸式、信息完整。
- 交互状态完善：骨架屏、空态、toast、样式化确认框、图标按钮。

---

## 2. 设计令牌（CSS 变量 + daisyUI 主题）

颜色、圆角、阴影统一为 CSS 变量，并在 Tailwind 的 theme 中映射为工具类（如 `bg-base-100`、`text-base-content`、`rounded-2xl`）。深色为默认，`[data-theme="light"]` 覆盖浅色版（同时可配合 daisyUI 内置主题）。

**深色（默认）**

| 变量 | 值 | 用途 |
|---|---|---|
| --bg | #0f1115 | 窗口背景 |
| --bg-elevated | #171a20 | 侧边栏 / 顶栏 |
| --surface | #1c2128 | 卡片 |
| --surface-2 | #232a33 | 卡片 hover |
| --border | #2a313b | 分隔线 / 边框 |
| --text | #f2f4f7 | 主文字 |
| --text-muted | #98a2b0 | 辅助文字 |
| --text-faint | #6b7480 | 极弱文字 |
| --accent | #4f8cff | 主操作 / 选中 |
| --accent-hover | #6ba1ff | 主操作 hover |
| --danger | #ef5350 | 危险操作 |
| --success | #45c586 | 成功提示 |
| --radius | 12px | 卡片圆角 |
| --radius-sm | 8px | 按钮 / 输入 |
| --shadow | 0 4px 18px rgba(0,0,0,.35) | 卡片 / 弹窗阴影 |

**浅色（[data-theme="light"]）**

--bg → #f4f5f7、--bg-elevated → #ffffff、--surface → #ffffff、
--surface-2 → #eef1f5、--border → #e3e7ed、
--text → #1d1f24、--text-muted → #5c6673、
--accent → #2563eb、阴影更浅。

---

## 3. 整体布局

    +-----------------------------------------------------------------+
    | Sidebar                      |  Content                          |
    | +---------------------------+ | +-----------------------------+ |
    | | 品牌 / 应用名             | | | 面包屑 · 标题 · 统计          | |
    | |                           | | | (右侧) 操作按钮组              | |
    | | 目录树 (可折叠)           | | +-----------------------------+ |
    | |  · 一级                  | | |                               | |
    | |  ·  ├ 二级               | | |  子文件夹卡片网格               | |
    | |  ·  └ 三级               | | |                              | |
    | |                           | | |  图片网格 (懒加载)            | |
    | | 导入报告 / 消息 / 关于    | | |                              | |
    | +---------------------------+ | +-----------------------------+ |
    +-----------------------------------------------------------------+

- **侧边栏可折叠**，默认 260px，收起后主区占满。
- **顶部 header**：左侧面包屑 + 当前目录名 + 统计；右侧主操作（导入 / 刷新 / 整理 / 导出 / 删除）+ 主题切换。
- 网格响应式：repeat(auto-fill, minmax(180px, 1fr))，图片卡片用 aspect-ratio: 4/3。

---

## 4. 组件设计

### 4.1 侧边栏
- 顶部品牌区：应用图标 + 名称。
- 目录树：行高加大（36px），选中态用 --accent 背景 + 白字；展开箭头精致化。
- 底部：导入报告入口、运行模式小字（弱化显示）、折叠按钮。

### 4.2 顶栏操作
- 主操作：+ 导入（primary）、刷新、整理、导出、删除（danger）。
- 次要用 ghost/icon 按钮；hover / disabled 状态统一。

### 4.3 文件夹卡片
- 封面 aspect-ratio: 4/3，圆角 12px，hover 上浮 + 阴影 + 边框高亮。
- 底部：名称 + N img / M sub，名称单行省略。

### 4.4 图片网格
- 卡片：缩略图 4:3 + 名称；hover 显示放大层。
- 加载态用 **skeleton shimmer**；失败态显示图标 + 中文提示。
- 支持懒加载（IntersectionObserver）。

### 4.5 查看器（沉浸式 Lightbox）
- 全屏黑色遮罩。
- 顶部工具条：关闭、上一/下一张、页码。
- 底部缩略图胶片条，当前项高亮。
- 右下信息栏：文件名、尺寸、缩放百分比。
- 保留：缩放 / 平移 / 旋转 / 键盘导航 / 相邻预取。

### 4.6 状态反馈
- **Toast**：右下角成功/错误/进行中提示（自动+手动可关闭）。
- **确认框**：样式化弹窗（替代 window.confirm）。
- **空态**：插画 + 一句话 + 引导按钮。
- **弹窗**：标题栏 + 关闭按钮 + 内容滚动。

---

## 5. 交互细节

- 图片 hover 快速预览/放大。
- 目录树切换有 120ms 过渡。
- 重复点击相同图片不改状态、不抖动。
- 键盘：←/→ 上一/下一张、↑/↓ 同级目录、Esc 关闭、+/−/0/1/R 缩放/适应/旋转。
- 深/浅色切换跟随系统，手动选择后记忆（localStorage）。

---

## 6. 文案

全部中文化按钮与提示，例如：

| 现状英文 | 改为 |
|---|---|
| Add Album | 导入相册 |
| Refresh | 刷新 |
| Organize Preview | 整理预览 |
| Undo Last Organize | 撤销上次整理 |
| Export ZIP | 导出 ZIP |
| Delete Album | 删除相册 |
| No images in this folder | 该目录暂无图片 |
| Cannot read | 图片读取失败 |

---

## 7. 落地步骤（后续，本次不执行）

1. 接入 **Tailwind CSS v4 + daisyUI v5**：安装依赖、配置 Vite/PostCSS、引入 Tailwind 与 daisyUI 插件，并定义主题（跟随系统 + 深浅切换记忆）。
2. 重写 `apps/web/src/styles.css`：保留设计令牌（CSS 变量），把通用组件类交给 daisyUI。
3. 调整 `packages/ui/src/LibraryBrowser.tsx` 布局：用 daisyUI 的 Navbar/Drawer/Menu 做侧边栏与顶栏，侧边栏可折叠、顶栏操作。
4. 重做 `Viewer` 为沉浸式 lightbox + 底部缩略图胶片条 + 信息栏。
5. 增强 `BlobImage`：骨架屏、失败态、懒加载（配合 daisyUI Skeleton）。
6. 用 daisyUI 的 Modal/Drawer/Toast 替换 `window.confirm` 与侧边栏消息；加空态组件。
7. 新增主题切换（`data-theme` + localStorage）。
8. 中文文案替换 + 移除调试徽章。

---

## 8. 验收标准

- 关闭应用应达到“像正式产品”的观感，而非测试 demo。
- 深浅色切换生效并被记忆。
- 现有功能（导入/目录树/整理/导出/删除/查看器/键盘导航）不回归。
- 图片多时不卡：懒加载缩略图 + 骨架屏。
- 所有交互有明确 hover/active/disabled 态。
