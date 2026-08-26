/**
 * 移动端 UI 共享工具与常量。
 * 纯逻辑函数直接复用桌面端实现（LibraryBrowser 中导出），此处仅 re-export，
 * 避免双份实现漂移；移动端特有的网格参数/格式化工具在此定义。
 */
export {
  windowRowsFor,
  clampWindow,
  OVERSCAN_ROWS,
  loadPinnedCovers,
  savePinnedCovers,
  loadBlurredImages,
  saveBlurredImages,
  isImageBlurred,
  skippedReasonLabel,
  conflictReasonLabel,
  prefetchOriginal,
  type GalleryMetrics,
} from '../LibraryBrowser';

/** 图片网格：3 列方形卡片（相册标准密度），卡片间距。 */
export const IMAGE_GRID = { cols: 3, gap: 3 } as const;
/** 文件夹网格：2 列卡片。 */
export const FOLDER_GRID = { cols: 2, gap: 10 } as const;
/** 内容区水平内边距（与 mobile CSS 对齐）。 */
export const CONTENT_PADDING_X = 10;

export function formatBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** 触觉反馈（Android WebView 支持 navigator.vibrate）。 */
export function haptic(duration = 12): void {
  try {
    navigator.vibrate?.(duration);
  } catch {
    // ignore
  }
}

export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_KEY = 'kanitu-theme';

export function loadThemeMode(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

/** 应用主题：data-theme 方案与桌面端一致；system 时跟随 prefers-color-scheme。 */
export function applyThemeMode(mode: ThemeMode): void {
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // ignore
  }
}
