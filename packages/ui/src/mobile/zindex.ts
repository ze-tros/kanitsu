/**
 * 移动端 overlay 层级常量（集中管理，替换散落的 z-[N] 魔法数字）。
 *
 * 说明：Tailwind 只对源码中「字面量」类名生成样式，`z-[${N}]` 这类动态拼接
 * 不会生成 CSS，因此这里统一用内联 `style={{ zIndex: N }}` 引用常量。
 */
export const Z_VIEWER = 120;
export const Z_SETTINGS = 120;
export const Z_DRAWER = 130;
export const Z_SHEET = 140;
export const Z_DIALOG = 150;
export const Z_BATCH_BAR = 155;
export const Z_PROGRESS = 160;
export const Z_TOAST = 170;
