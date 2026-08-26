# 移动端 UI 改进点（Android）

> 状态：待实施清单（2026-08-26 整理）。本文基于对 `packages/ui/src/mobile/` 全部源码
> （MobileApp 1486 行 / MobileViewer 673 行 / MobileSheets 265 行）的走查，对照
> `DESIGN.md` 与桌面端 `LibraryBrowser` 列出改进点，按 P0/P1/P2 分级。
> 现有 UI 的设计决策见 `移动端UI设计.md`。

---

## 一、体验问题（实际 bug / 明显短板）

### 1. 查看器手势缺陷（P0，最高优先）

`MobileViewer.tsx` 是核心体验，存在以下问题：

- **上滑被误判为 swipe，长图无法垂直滚动**：
  `onPointerMove` 中 `g.mode = Math.abs(dx) >= Math.abs(dy) ? 'swipe' : dy > 0 ? 'close' : 'swipe'`
  ——上滑（`dy < 0`）落入 `swipe` 分支，漫画/长截图场景下用户无法上滑查看图片顶部。
- **缩放边界钳制在图片未加载完成时错误**：`clampPan` 依赖 `naturalW/H`，未就绪时回退
  成 `containerSize`，导致加载中拖动被错误钳制。
- **双击缩放固定 2.5x**：DESIGN.md 8.3 要求「100% ↔ 适应窗口」切换；`MAX_SCALE = 6`
  与设计值 8x 不符。
- **翻页动画用 `setTimeout(240)` 而非 `transitionend`**：`navigateWithAnimation` 在慢
  设备上动画未结束就切图，出现闪烁。
- **胶片条 `Filmstrip` 无虚拟化**：`images.map` 全量渲染，几千张图时直接 OOM。
- **`VirtualGrid` 每行都加 `willChange: 'transform'`**：行数多时浪费大量合成层内存。

### 2. 返回键栈实现脆弱（P0）

`MobileApp.tsx` 474–586 行的手写栈（`stackRef` + `history.pushState` +
`consumedPopsRef`）：

- `closeOverlay` 先 `consumedPopsRef.current++` 再 `history.back()`，popstate 异步
  触发，快速连续操作（如 viewer → sheet → 快速两次返回）存在竞态，栈会错乱。
- 新增 overlay 类型必须在 `closeOverlayUI` 手动加 case，易漏。
- **建议**：改为显式状态机（reducer / XState），或直接用 `history.state` 存栈快照，
  避免双份数据。

### 3. 进度反馈缺失（P0）

- **导入/导出/整理均无取消按钮**：`MobileProgressCard` 只显示进度；DESIGN.md 5.1
  明确要求「支持取消；已复制文件保留，重试时按 size+mtime 跳过」。大目录导入数分钟，
  用户只能杀进程。
- **进度期间不阻止其他操作**：用户仍可打开查看器/sheet，状态易错乱。
- **导入完成后不自动展示报告**：`setImportReport` 后需手动「更多 → 查看导入报告」，
  用户无法感知跳过/失败文件。

### 4. 虚拟化网格不完善（P1）

`VirtualGrid`（MobileApp.tsx 136–187）：

- **不支持动态行高**：文件夹区（`aspect-[16/10]` + 46px caption）与图片区
  （`aspect-square`）行高写死；DESIGN.md 4.3「包含子目录聚合视图」落地时需重算。
- **`items.slice()` 在 render 内执行**：每次滚动都对全量数组 slice，1 万图时 GC 压力
  大，应 `useMemo` 分页。
- **key 用行号 `r`**：快速滚动时 React 复用错误行的组件，`BlobImage` 的 `lazy` 状态
  会串图，应改用 `getKey(items[r * cols])`。

---

## 二、功能缺失（DESIGN.md 承诺但未实现）

### 5. 移动端缺失的核心功能（P1）

对比 DESIGN.md 与桌面端 `LibraryBrowser`：

| 功能 | 桌面端 | 移动端 | 依据 |
|---|---|---|---|
| 包含子目录聚合视图 | ✅ | ❌ | DESIGN.md 4.3 |
| 排序（名称/日期/大小） | ✅ | ❌ | DESIGN.md 8.1 |
| 网格尺寸切换 | ✅ | ❌ | DESIGN.md 8.1 |
| 前进/后退导航 | ✅ | 仅返回 | DESIGN.md 16 已实现 |
| EXIF 信息查看 | ✅（`I` 键） | ❌ | DESIGN.md 8.2 |
| 图片旋转 | ✅（`R` 键） | ❌ | DESIGN.md 8.2 |
| GIF 播放控制（暂停/逐帧） | ✅ | ❌ 自动播放 | DESIGN.md 9.1 |
| 多选 / 批量操作 | ✅ | ❌ | 导出/删除需逐个 |
| 重命名顶层图包 | ✅ | ❌ | DESIGN.md 14.3 |

### 6. 长按手势可用性（P0）

`useLongPress`（460ms）：

- **与滚动冲突**：`onTouchMove: cancel`——手指移动 1px 即取消，网格中手抖变滚动，
  应加 ~10px 位移阈值。
- **无触发前视觉反馈**：用户不知还需按多久，应加按压渐进效果（如 iOS 的深化）。
- **与 `active:opacity-80` 冲突**：按下即变透明度，长按触发时用户误以为已单击。

### 7. 搜索能力弱（P1）

- **仅支持当前目录**：无跨图包全局搜索，几千张图时是刚需。
- **无防抖**：`onChange` 直接 `setSearchQuery`，每次击键都触发 `folderImages` 重算。
- **无结果定位**：搜索进入图片后关闭搜索，回不到之前浏览位置。

---

## 三、视觉 / 细节问题

### 8. 视觉层级与密度（P1）

- **图片卡片无文件名**：`ImageCard` 纯缩略图。「按命名整理」是核心场景，用户在网格
  无法确认整理结果，应加可选文件名显示（或长按浮出）。
- **文件夹卡片密度低**：2 列 `16:10` 卡片一屏仅 4–6 个，几百图包时应提供列表视图。
- **图标全用 emoji**：👁🕶📌✏️🔗🗑📂🧹📦⚙️ 在各 Android 版本渲染差异大（部分显示
  方框），与 daisyUI 风格不统一，应替换为 SVG icon。

### 9. 动画与过渡（P2）

- **查看器打开无共享元素过渡**：DESIGN.md 8.5 要求 FLIP，目前是 `fixed inset-0` 硬切。
- **ActionSheet 下滑关闭阈值 90px 过小**：滚动列表时易误触关闭。
- **目录切换无 FLIP 重排**：DESIGN.md 要求「网格 FLIP 重排」，目前是卸载重建。
- **Toast 位置固定 `bottom: 88px`**：折叠屏/平板横屏时会被 FAB 遮挡。

### 10. 可访问性 a11y（P2）

- **大量 `div onClick`**：`ImageCard` / `FolderCard` / `MobileFolderTree` 行均非
  `<button>`，屏幕阅读器无法识别。
- **`aria-label` 覆盖不全**：卡片、列表项缺失。
- **无 `prefers-reduced-motion` 降级**：DESIGN.md 8.5 明确要求，目前所有动画强制
  播放。
- **对比度不足**：`text-[11px] opacity-60` / `text-xs opacity-50` 在浅色主题下不达
  WCAG AA。

---

## 四、工程 / 性能

### 11. 内存与性能隐患（P1）

- **`MobileViewer` 的 `pages` Map 无限增长**：浏览过的每张图都缓存
  `thumbUrl + fullUrl`，刷几百张后内存膨胀。桌面端有 `objectUrlPool` LRU，移动端
  查看器只用了部分，应接入相同的 LRU 淘汰。
- **`childFolderCards` 每次 render 重算 `pickCover`**：几百子文件夹时卡帧，应缓存
  到 snapshot 或 IndexedDB。
- **`expandedFolders` 用 `ReadonlySet` 每次新建**：目录树大时递归组件
  `MobileFolderTree` 频繁整体重渲染，应改 `Map<id, boolean>` 或 immer。
- **滚动方向预取过敏感**：`lastScrollTopRef` 方向一变即触发 `preloadThumbnails`，
  快速来回滚动重复提交大量任务，应加节流。

### 12. 代码结构（P2）

- **`MobileApp.tsx` 1486 行单文件**：状态、手势、业务、渲染混杂，应拆分为
  `useLibrarySnapshot` / `useBackStack` / `useImportTask` / `useOrganizeTask` 等 hook。
- **与桌面端逻辑重复**：`useLongPress` vs 桌面右键、`VirtualGrid` vs TanStack
  Virtual、`MobileViewer` vs 桌面查看器两套实现持续漂移。DESIGN.md 目标「共享 90%
  代码」，UI 层实际共享度远低于此。
- **z-index 硬编码散落**：`z-[120]`（viewer）/ `z-[130]`（drawer）/ `z-[140]`
  （sheet）/ `z-[150]`（dialog）/ `z-[160]`（progress）/ `z-[170]`（toast）应集中
  为常量管理。

---

## 五、实施优先级

### P0 —— 影响核心体验，尽快修

| # | 项 | 位置 |
|---|---|---|
| 1 | 查看器上滑滚动长图 / 下滑关闭手势冲突 | `MobileViewer.tsx` `onPointerMove` |
| 2 | 返回键栈竞态 | `MobileApp.tsx` 474–586 |
| 3 | 长按手势位移阈值 + 触发前视觉反馈 | `useLongPress` |
| 4 | 胶片条虚拟化 | `MobileViewer.tsx` `Filmstrip` |
| 5 | 导入/导出/整理取消按钮 | `MobileProgressCard` + 桥接层 |

### P1 —— 功能完整性

| # | 项 |
|---|---|
| 6 | 包含子目录聚合视图（DESIGN.md 4.3） |
| 7 | 全局搜索（跨图包）+ 防抖 |
| 8 | 多选 / 批量操作 |
| 9 | 网格文件名显示开关 + 列表视图 |
| 10 | 排序（名称/日期/大小） |
| 11 | `MobileViewer` pages LRU 淘汰 |
| 12 | 排序 / EXIF / 旋转 / GIF 控制补齐 |

### P2 —— 打磨

| # | 项 |
|---|---|
| 13 | 查看器共享元素 FLIP 过渡 |
| 14 | 统一 SVG 图标替换 emoji |
| 15 | `prefers-reduced-motion` 降级 |
| 16 | `MobileApp.tsx` 拆分 hook |
| 17 | a11y 修复（button 语义 / aria / 对比度） |
| 18 | z-index 常量化 |

---

## 六、建议落地顺序

1. **第一批（P0 全部）**：查看器手势（上滑/双击/动画回调）、返回栈重构、长按阈值、
   胶片条虚拟化、任务取消。
2. **第二批（P1 体验向）**：聚合视图、全局搜索、多选、文件名显示。
3. **第三批（P1 性能向 + P2）**：pages LRU、pickCover 缓存、共享元素过渡、图标与
   a11y、代码拆分。
