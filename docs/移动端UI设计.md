# 移动端 UI 设计（Android）

> 状态：v0.1 已落地（2026-08-26）。本文记录「为 Android 端重写全新 UI」（替代原桌面端
> 移植 UI）的架构决策、交互设计与实现清单，配套提交见当日 `feat(android)` 提交。
> 平台能力层（SAF/图库/缩略图/导出）设计见 `Android端设计.md`，本文只覆盖 UI 层。

---

## 1. 背景与目标

原 Android 端直接复用桌面端 `LibraryBrowser`（2268 行），仅靠少量 `<1024px` 媒体查询
压缩布局，是典型的「桌面移植 UI」：顶栏导航图标拥挤、操作按钮一字排开、依赖右键菜单
与滚轮，不适合触摸操作。

**目标：为 Android 端设计一套触摸优先的全新 UI，桌面端 UI 零改动、零风险。**

验收标准：APK 安装后得到符合移动端习惯的原生观感——App Bar、FAB、底部动作面板、
手势查看器、系统返回键逐级返回、全面屏安全区适配。

---

## 2. 关键修复：平台启动检测失效

### 问题

`App.tsx` 用 `window.kanituAndroid?.platform === 'android'` 判断平台，但该桥对象由
`requireBridge()` **首次调用时才异步注册**（`fs-adapter/android.ts`），启动时必然为
`undefined` → Android 真机启动实际落入 **Memory 演示分支**（内存库，重启即失，且
「导入」导入的是演示数据而非 SAF）。

### 修复（`apps/web/src/App.tsx`）

- 平台检测改为多级：`window.kanituDesktop`（Electron）→ `window.kanituAndroid` →
  `window.Capacitor.getPlatform()` → **`window.androidBridge`**（Capacitor native bridge
  在 WebView 加载早期注入，Capacitor 源码自身也以此判别 Android，启动时同步可用）。
- Android 平台启动时先 `initAndroidBridge()`（`fs-adapter/android.ts` 新导出，预热注册
  `window.kanituAndroid`），完成后才渲染 UI，消除适配器首次调用时的注册竞态。
- 分发：Android → `MobileApp`；Electron/Web → `LibraryBrowser`（桌面 UI 不变）。

---

## 3. 架构决策

### 独立移动端组件树，不复用桌面 LibraryBrowser

桌面/移动交互模型差异过大（右键 vs 长按、滚轮 vs 触摸惯性、侧栏 vs 抽屉、键盘导航 vs
系统返回键），硬揉进同一组件会让 2268 行的文件更难维护。决策：

- 新建 `packages/ui/src/mobile/`，全新实现移动端组件树。
- 桌面 `LibraryBrowser.tsx` **逻辑零改动**，仅将可复用的纯函数加 `export`：
  `windowRowsFor` / `clampWindow` / `OVERSCAN_ROWS`（虚拟化窗口算法）、
  `loadPinnedCovers` / `savePinnedCovers` / `loadBlurredImages` / `saveBlurredImages` /
  `isImageBlurred`（localStorage 持久化）、`skippedReasonLabel` / `conflictReasonLabel`
  （报告文案）、`prefetchOriginal`（原图 LRU 预取池）。
- 全量复用：Core（扫描/导入/整理/删除/重命名）、`thumbnailCache` 五级优先级预取、
  `BlobImage`（懒加载缩略图）、`OrganizePreview` / `CoverPickerModal`（桌面 modal 组件，
  移动端用 CSS 容器类 `.m-fullscreen` 覆盖成全屏，不改组件本体）、
  `OrganizeRulesManager`（设置页规则管理）。

### 文件结构

```
packages/ui/src/mobile/
├─ MobileApp.tsx             # 主壳：状态、导航栈、浏览主页、抽屉、对话框、报告
├─ MobileViewer.tsx          # 手势查看器（捏合缩放/滑页/下滑关闭/单击隐 UI）
├─ MobileSheets.tsx          # 底部动作面板 / 确认框 / 输入框 / Toast / 进度卡
├─ MobileSettingsScreen.tsx  # 设置页（主题/规则/性能/缓存/调试，桥接 kanituAndroid）
└─ mobileShared.ts           # 复用函数 re-export + 移动端常量 + 主题/震动工具
```

样式：`apps/web/src/styles.css` 追加移动端段（面板/抽屉/对话框动画、`.m-fullscreen`
modal 全屏化、胶片条隐藏滚动条、安全区 padding），全部以 `m-` 前缀隔离。

---

## 4. 交互设计

### 浏览主页

- **App Bar**：根目录=☰（开抽屉）+ 标题「全能看图王」；子目录=‹ 返回 + 目录名 +
  统计（直属图片/子目录数）；右侧固定 🔍（搜索模式）与 ⋮（更多）。
- **内容区**：子文件夹 2 列卡片（16:10 封面 + 名称 + 计数）→ 图片 3 列方形网格
  （无文件名，相册密度）。两区均虚拟化（可视行 ±2，复用桌面窗口算法），行高由容器宽
  直接计算（方形/固定标题高，免探测卡）。
- **FAB**：右下角主按钮 = SAF 导入；导入中隐藏，改显底部进度卡（已扫描/已复制/跳过）。
- **抽屉**：左滑入目录树（全部相册 + 递归树，44px 触控行高，展开/收起 chevron），
  底部设置入口。
- **搜索模式**：App Bar 变搜索框，实时过滤当前目录（与桌面语义一致）。
- **下拉/刷新**：刷新收敛进 ⋮ 菜单。

### 长按动作面板（替代右键菜单）

图片/文件夹长按（460ms + 震动反馈）→ 底部滑入动作面板：大触控项（py-3.5）、
危险项红色、拖动把手可下滑关闭、遮罩点击关闭。动作集与桌面右键菜单对齐
（查看/隐私预览/设封面/重命名/复制路径/删除；文件夹另有新建子文件夹/整理/导出）。

### 查看器（手势状态机，Pointer Events）

| 手势 | 行为 |
|---|---|
| 单指左右滑 | 跟手翻页（prev/cur/next 三页横排，阈值 64px 或速度 0.35px/ms 触发，边界回弹） |
| 单指下滑 | 未放大时跟手下移 + 背景渐隐，超 110px 或快速下滑则关闭 |
| 双指捏合 | 以双指中点为焦点缩放（0.9–6x），捏合结束 <1x 回弹适应 |
| 放大后单指 | 平移（边界 clamp） |
| 双击 | 适应 ↔ 2.5x（以点击点为焦点） |
| 单击 | 切换顶栏/胶片条显隐（300ms 窗区分双击） |

加载沿用桌面三段式：缩略图（512px）铺底 → 原图 `onLoad` 淡入（无黑屏），
相邻 ±2 原图错峰预解码进 LRU 池；顶栏显示文件名/序号/分辨率，底部胶片条点击跳转
并自动居中。

### 系统返回键（history 混合栈）

不依赖新插件，用 History API 实现「逐级返回，最后退出」：

- 栈元素 = 目录导航（`{type:'folder'}`）与 UI 层（`{type:'overlay', layer}`：drawer /
  sheet / viewer / settings / organize / cover / dialog / report / search）。
- 打开层 = `pushState` + 入栈；`popstate` = 出栈并关闭对应 UI（目录层则恢复目标目录）。
- **主动/被动关闭区分**：UI 内按钮主动关闭时同步出栈 + `consumedPopsRef++` +
  `history.back()`，`popstate` 识别 consumed 计数直接跳过——避免主动关闭与事件重复
  消费两层，也保证动作面板「先关面板再开对话框」的时序正确。
- 栈空（根目录无浮层）时系统返回键走 WebView 默认行为退出应用。

### 全面屏与安全区

所有固定元素使用 `env(safe-area-inset-*)`：App Bar/抽屉/全屏页预留状态栏高度，
FAB/Toast/进度卡/面板避开底部手势条。`MainActivity` 已设状态栏/导航栏配色。

---

## 5. 移动端设置页

全屏列表式（替代桌面侧边栏布局）：外观（跟随系统/浅色/深色段控件，`data-theme` 方案
与桌面一致）、整理规则（复用 `OrganizeRulesManager`）、性能（预取开关）、缓存
（渲染端统计 + `kanituAndroid.getThumbnailStats` 原生磁盘统计 + 双端清除）、调试
（日志等级同步原生 + 渲染端/原生日志查看）、关于（Android 模式 + 桥版本）。
桥读取封装为 `androidBridge()` 类型化辅助（ui 包不依赖 fs-adapter 的全局声明）。

---

## 6. 实现清单与验证状态

| 项 | 状态 |
|---|---|
| 平台启动检测修复（androidBridge 判别 + 桥预热） | ✅ 真机验证（SAF 选择器正常弹出） |
| 浏览主页（App Bar/虚拟化网格/FAB/抽屉/搜索/空态） | ✅ 真机验证首屏渲染 |
| 长按动作面板 + 确认/输入对话框 + Toast + 进度卡 | ✅ 已实现，真机流程待回归 |
| 手势查看器（翻页/捏合/下滑关闭/双击/单击） | ✅ 已实现，真机手势待回归 |
| 返回键混合栈 | ✅ 已实现，真机待回归 |
| 设置页 / 整理预览 / 封面选择（全屏化） | ✅ 已实现，真机待回归 |
| `npm run typecheck` 全 workspace | ✅ 通过 |
| `npm run build:mobile` + `gradlew assembleDebug` | ✅ 通过（app-debug.apk） |

### 遗留 / 后续

1. **真机回归**：导入完成 → 网格浏览 → 查看器手势 → 长按操作 → 返回键链路需逐项
   回归（本次验证到 SAF 选择器弹出为止，导入尚未走完）。
2. 查看器暂未提供单图旋转（手机上依赖系统方向；如需可后补，需处理 rotate 与
   缩放/平移边界的组合）。
3. 面板/抽屉关闭暂无退场动画（入场有）；下滑关闭手势仅动作面板支持。
4. 大库（1000+ 图）滚动帧率、缩略图队列在真机的表现未压测。
5. 横屏/折叠屏布局未做（当前按竖屏设计）。

---

## 7. 一句话结论

Android 端 UI 与桌面端彻底分家：`packages/ui/src/mobile/` 全新触摸组件树 +
History 返回键栈 + 手势查看器，复用全部 Core/缩略图/预取能力，桌面端零改动；
同时修复了启动时平台检测失效导致误入 Memory 演示分支的存量 bug。
