/**
 * 主题色：桌面与移动端共用同一组取值与文案（不依赖 React，便于单测）。
 * 色板本身在各端 CSS 里（--desktop-accent-* / --m-accent-*），这里只放标识与显示名。
 */
export const ACCENT_MODES = ['cobalt', 'coral', 'amber', 'graphite'] as const;
export type AccentMode = (typeof ACCENT_MODES)[number];

export const ACCENT_OPTIONS: ReadonlyArray<{ value: AccentMode; label: string }> = [
  { value: 'cobalt', label: '岩蓝' },
  { value: 'coral', label: '朱砂' },
  { value: 'amber', label: '琥珀' },
  { value: 'graphite', label: '墨灰' },
];

export const DEFAULT_ACCENT: AccentMode = 'coral';

export function isAccentMode(value: unknown): value is AccentMode {
  return typeof value === 'string' && (ACCENT_MODES as readonly string[]).includes(value);
}
