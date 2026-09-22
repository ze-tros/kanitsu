/**
 * 移动端 overlay 层级常量（集中管理，替换散落的 z-[N] 魔法数字）。
 *
 * 说明：Tailwind 只对源码中「字面量」类名生成样式，`z-[${N}]` 这类动态拼接
 * 不会生成 CSS，因此这里统一用内联 `style={{ zIndex: N }}` 引用常量。
 *
 * 排序语义「越临时越在上」：常驻 chrome（批量栏） < 页面（设置/查看器）
 * < 临时浮层（抽屉/面板/对话框） < 任务进度/Toast。批量栏属于常驻 chrome，
 * 必须低于一切浮层——层级倒置会让它穿透动作面板/对话框，误触批量删除。
 *
 * 注意：styles.css 的 `.m-fullscreen .modal.modal-open` 还有一处 z-index: 125
 * （= Z_FULLSCREEN_MODAL），修改时两处需同步。
 */
export const Z_BATCH_BAR = 115;
export const Z_SETTINGS = 120;
export const Z_VIEWER = 121;
/** 对应 styles.css 中 `.m-fullscreen .modal.modal-open` 的 z-index（两处同步改）。 */
export const Z_FULLSCREEN_MODAL = 125;
export const Z_DRAWER = 130;
export const Z_SHEET = 140;
export const Z_DIALOG = 150;
export const Z_PROGRESS = 160;
export const Z_TOAST = 170;
