/**
 * 移动端 UI 共享工具与常量。
 * 纯逻辑函数直接复用桌面端实现（LibraryBrowser 中导出），此处仅 re-export，
 * 避免双份实现漂移；移动端特有的网格参数/格式化工具在此定义。
 */
export {
  loadPinnedCovers,
  savePinnedCovers,
  loadBlurredImages,
  saveBlurredImages,
  isImageBlurred,
  skippedReasonLabel,
  conflictReasonLabel,
} from '../LibraryBrowser';

import { DEFAULT_ACCENT, isAccentMode, type AccentMode } from '../accents';
import type { KanitsuAndroidBridge } from '../../../fs-adapter/src/android';

/** 图片网格：默认 3 列方形卡片，捏合可在 min..max 之间调整；间距与圆角随列数收紧。 */
export const IMAGE_GRID = { cols: 3, minCols: 2, maxCols: 6 } as const;
/** 卡片网格间距（px）：列数越多越紧凑（3 列 ≈ 10px，6 列 ≈ 5px）。 */
export function imageGridGap(cols: number): number {
  return Math.round(14 - cols * 1.5);
}
/** 文件夹网格：默认 2 列封面卡片，可选 3 列。 */
export const FOLDER_GRID = { cols: 2, gap: 12 } as const;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function loadImageGridCols(): number {
  const n = Number(readPref('kanitsu.gridCols'));
  return Number.isInteger(n) && n >= IMAGE_GRID.minCols && n <= IMAGE_GRID.maxCols ? n : IMAGE_GRID.cols;
}

export function saveImageGridCols(cols: number): void {
  writePref('kanitsu.gridCols', String(cols));
}

export type LibrarySort = 'recent' | 'name' | 'count' | 'size';
export const LIBRARY_SORT_LABELS: Record<LibrarySort, string> = { recent: '最近导入', name: '名称', count: '图片数', size: '占用' };

export interface LibraryPrefs {
  sort: LibrarySort;
  view: 'grid' | 'list';
  cols: 2 | 3;
}

export function loadLibraryPrefs(): LibraryPrefs {
  const sort = readPref('kanitsu.libSort');
  return {
    sort: sort === 'name' || sort === 'count' || sort === 'size' ? sort : 'recent',
    view: readPref('kanitsu.libView') === 'list' ? 'list' : 'grid',
    cols: readPref('kanitsu.libCols') === '3' ? 3 : 2,
  };
}

export function saveLibraryPrefs(prefs: LibraryPrefs): void {
  writePref('kanitsu.libSort', prefs.sort);
  writePref('kanitsu.libView', prefs.view);
  writePref('kanitsu.libCols', String(prefs.cols));
}

/** RAW 查看：当前页是否在相机内嵌预览之后继续后台完整解码（默认开启）。 */
export function isRawFullDecodeEnabled(): boolean {
  return readPref('kanitsu.mobileRawFullDecode') !== '0';
}

export function setRawFullDecodeEnabled(enabled: boolean): void {
  writePref('kanitsu.mobileRawFullDecode', enabled ? '1' : '0');
}

const RECENT_SEARCH_KEY = 'kanitsu.recentSearches';

export function loadRecentSearches(): string[] {
  try {
    const list = JSON.parse(readPref(RECENT_SEARCH_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function pushRecentSearch(list: readonly string[], query: string): string[] {
  const q = query.trim();
  if (!q) return [...list];
  const next = [q, ...list.filter((v) => v !== q)].slice(0, 8);
  writePref(RECENT_SEARCH_KEY, JSON.stringify(next));
  return next;
}

export function clearRecentSearches(): void {
  writePref(RECENT_SEARCH_KEY, '[]');
}

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

/** 从移动设计令牌读取色值（系统栏/meta theme-color 的单一来源：mobile.css 的 --m-app/--m-surface-1）。 */
function readShellToken(name: string, fallback: string): string {
  try {
    const el = document.querySelector('.mobile-studio') ?? document.documentElement;
    const value = getComputedStyle(el).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
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
  // 与桌面端（LibraryBrowser）同口径：UA 原生控件（滚动条/文本选择/表单）随主题换明暗。
  document.documentElement.style.colorScheme = resolved;
  // 状态栏对齐画布（--m-app）、导航栏对齐底部操作区（--m-surface-1）：meta theme-color
  // 与系统栏色同源下发，消除状态栏与页面底色的色差（fallback 取 mobile.css 令牌值）。
  const fallback = resolved === 'light' ? { app: '#e9ebee', surface: '#fbfcfd' } : { app: '#111112', surface: '#18181a' };
  const statusColor = readShellToken('--m-app', fallback.app);
  const navColor = readShellToken('--m-surface-1', fallback.surface);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', statusColor);
  syncAndroidSystemBars(resolved === 'dark', statusColor, navColor);
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // ignore
  }
}

/**
 * 把解析后的主题同步给 Android 系统栏（底色 + 图标明暗）。色值由 JS 从设计令牌算出后
 * 下发，原生侧不再各自硬编码调色板。桥接未就绪（web/electron）时是空操作；调用失败
 * 静默忽略，不影响主题本身。ui 包不依赖 fs-adapter 的全局 Window 声明，
 * 这里做类型化读取（同 MobileSettingsScreen）。
 */
function syncAndroidSystemBars(dark: boolean, statusColor: string, navColor: string): void {
  try {
    const bridge = (window as unknown as { kanitsuAndroid?: KanitsuAndroidBridge }).kanitsuAndroid;
    void bridge?.setSystemTheme?.(dark, statusColor, navColor)?.catch(() => {
      // ignore
    });
  } catch {
    // ignore
  }
}

const ACCENT_KEY = 'kanitsu-accent';

/** 读取主题色偏好（与桌面端共用 kanitsu-accent 键），无有效值时用默认朱砂。 */
export function loadAccentMode(): AccentMode {
  try {
    const value = localStorage.getItem(ACCENT_KEY);
    if (isAccentMode(value)) return value;
  } catch {
    // ignore
  }
  return DEFAULT_ACCENT;
}

/** 应用主题色：写 data-accent（mobile.css 的 accent 覆盖规则据此生效）并持久化。 */
export function applyAccentMode(mode: AccentMode): void {
  document.documentElement.setAttribute('data-accent', mode);
  try {
    localStorage.setItem(ACCENT_KEY, mode);
  } catch {
    // ignore
  }
}

/**
 * 在移动端根视图挂载时立即恢复主题与主题色，并在「跟随系统」模式下监听系统主题变化。
 * 监听器每次都读取当前偏好，避免用户切到固定主题后被后续系统事件覆盖。
 */
export function startThemeModeSync(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: light)');
  applyThemeMode(loadThemeMode());
  applyAccentMode(loadAccentMode());
  const handleChange = (): void => {
    if (loadThemeMode() === 'system') applyThemeMode('system');
  };
  media.addEventListener('change', handleChange);
  return () => media.removeEventListener('change', handleChange);
}
