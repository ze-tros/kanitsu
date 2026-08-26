import type { JSX, ReactNode } from 'react';

/**
 * emoji → SVG 图标（替换散落的 emoji，统一 daisyUI 线性风格；各 Android 版本
 * emoji 渲染差异大，部分会显示方框）。未知 emoji 回退为字符本身。
 */

const EYE = <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />;
const EYE_OFF = (
  <g>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="M2 2l20 20" />
  </g>
);
const PIN = <g><path d="M12 17v5" /><path d="M9 10.76V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4.76l2 2V14H7v-1.24z" /></g>;
const EDIT = <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />;
const LINK = <g><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></g>;
const TRASH = <g><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></g>;
const FOLDER = <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />;
const FOLDER_PLUS = <g><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><path d="M12 11v6M9 14h6" /></g>;
const LIST = <g><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></g>;
const BOX = <g><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></g>;
const CLIPBOARD = <g><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></g>;
const SETTINGS = <g><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></g>;
const DOWNLOAD = <g><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" /></g>;
const CHECK = <path d="M20 6L9 17l-5-5" />;
const UNDO = <g><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-15-6.7L3 13" /></g>;
const CLOCK = <g><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></g>;
const BARS = <g><path d="M3 7h18" /><path d="M3 12h12" /><path d="M3 17h7" /></g>;
const LETTER_A = <g><path d="M4 6h8M4 20h8M12 6c2.5 0 3.5 2.5 3.5 5s-1 5-3.5 5" /><path d="M15 8l2-4 2 4" /><path d="M15.5 12h3" /></g>;
const GRID = <g><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></g>;
const TAG = <g><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><circle cx="7" cy="7" r="1.5" /></g>;
const REFRESH = <g><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></g>;
const SEARCH = <g><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></g>;
const IMAGE = <g><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></g>;
const HOME = <path d="M3 10.5L12 3l9 7.5V21H3z" />;
const UPLOAD = <g><path d="M12 15V3" /><path d="M7 8l5-5 5 5" /><path d="M4 21h16" /></g>;

/** emoji → SVG 内容（未收录的返回 null，由调用方回退为字符）。 */
const ICON_PATHS: Record<string, ReactNode> = {
  '👁': EYE,
  '🕶': EYE_OFF,
  '📌': PIN,
  '✏️': EDIT,
  '🔗': LINK,
  '🗑': TRASH,
  '📂': FOLDER,
  '📁': FOLDER_PLUS,
  '🧹': LIST,
  '📦': BOX,
  '📋': CLIPBOARD,
  '⚙️': SETTINGS,
  '⬇️': DOWNLOAD,
  '✅': CHECK,
  '↩️': UNDO,
  '🕐': CLOCK,
  '📐': BARS,
  '🔤': LETTER_A,
  '📚': GRID,
  '🔳': GRID,
  '☰': LIST,
  '🏷️': TAG,
  '🔄': REFRESH,
  '🔍': SEARCH,
  '🖼️': IMAGE,
  '🏠': HOME,
  '⬆️': UPLOAD,
};

/** 渲染一个图标：emoji 命中映射时输出 SVG，否则回退为字符文本。 */
export function MobileIcon({ name, className = 'w-5 h-5' }: { name: string; className?: string }): JSX.Element {
  const content = ICON_PATHS[name];
  if (!content) {
    return <span className={className + ' flex items-center justify-center'}>{name}</span>;
  }
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {content}
    </svg>
  );
}
