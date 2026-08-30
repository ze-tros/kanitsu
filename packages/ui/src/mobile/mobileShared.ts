/**
 * 移动端 UI 共享工具与常量。
 * 纯逻辑函数直接复用桌面端实现（LibraryBrowser 中导出），此处仅 re-export，
 * 避免双份实现漂移；移动端特有的网格参数/格式化工具在此定义。
 */
export {
  windowRowsFor,
  clampWindow,
  OVERSCAN_ROWS,
  type GalleryMetrics,
} from '../virtualWindow';

export {
  loadPinnedCovers,
  savePinnedCovers,
  loadBlurredImages,
  saveBlurredImages,
  isImageBlurred,
  skippedReasonLabel,
  conflictReasonLabel,
  prefetchOriginal,
} from '../LibraryBrowser';

/** 图片网格：3 列方形卡片（相册标准密度），卡片间距。 */
export const IMAGE_GRID = { cols: 3, gap: 3 } as const;
/** 文件夹网格：2 列卡片。 */
export const FOLDER_GRID = { cols: 2, gap: 10 } as const;
/** 内容区水平内边距（与 mobile CSS 对齐）。 */
export const CONTENT_PADDING_X = 10;

/** 系统是否开启「减少动态效果」。动画/过渡应据此降级（DESIGN.md 8.5）。 */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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

const THEME_KEY = 'kanitsu-theme';

export function loadThemeMode(): ThemeMode {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  } catch {
    return 'system';
  }
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#e7e9ed' : '#0e1014');
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // ignore
  }
}

/**
 * 在移动端根视图挂载时立即恢复主题，并在「跟随系统」模式下监听系统主题变化。
 * 监听器每次都读取当前偏好，避免用户切到固定主题后被后续系统事件覆盖。
 */
export function startThemeModeSync(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: light)');
  applyThemeMode(loadThemeMode());
  const handleChange = (): void => {
    if (loadThemeMode() === 'system') applyThemeMode('system');
  };
  media.addEventListener('change', handleChange);
  return () => media.removeEventListener('change', handleChange);
}
