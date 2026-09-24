import type { JSX, ReactNode } from 'react';

/**
 * 移动端线性图标（24 栅格描边）。一律用受控图标名 MobileIconName：各 Android 版本
 * emoji 渲染差异大（部分显示方框），旧的 emoji 键调用点已全部迁移。
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
const SETTINGS = <g><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></g>;
const DOWNLOAD = <g><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" /></g>;
const CHECK = <path d="M20 6L9 17l-5-5" />;
const UNDO = <g><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-15-6.7L3 13" /></g>;
const CLOCK = <g><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></g>;
const GRID = <g><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></g>;
const TAG = <g><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><circle cx="7" cy="7" r="1.5" /></g>;
const REFRESH = <g><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></g>;
const SEARCH = <g><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></g>;
const IMAGE = <g><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></g>;

const BACK = <path d="M15 18l-6-6 6-6" />;
const CLOSE = <path d="M6 6l12 12M18 6L6 18" />;
const MORE = <path d="M12 5h.01M12 12h.01M12 19h.01" strokeWidth="3.2" />;
const PLUS = <path d="M12 5v14M5 12h14" />;
const CHEVRON_RIGHT = <path d="M9 6l6 6-6 6" />;
const CHEVRON_DOWN = <path d="M6 9l6 6 6-6" />;
const TASKS = <path d="M4 6h10M4 12h7M4 18h10M15 12l2.5 2.5L22 10" />;
const TREE = <path d="M4 4h6v5H4zM14 11h6v5h-6zM14 18.5h6M7 9v9.5h7M7 13.5h7" />;
const TUNE = <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" />;
const SORT = <path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" />;
const WAND = <path d="M4 20L15 9M13 7l4 4M18 3v3M16.5 4.5h3M8 3v2M7 4h2M20 12v2M19 13h2" />;
const ZIP = <path d="M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8" />;
const SELECT_ALL = <g><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 12l3 3 5-6" /></g>;
const LAYERS = <path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5" />;
const ROTATE = <g><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></g>;
const INFO = <g><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></g>;
const MOVE = <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 13h7M13 10.5l2.5 2.5-2.5 2.5" />;
const IMAGES = <path d="M7 3h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM3 7v12a2 2 0 0 0 2 2h12M21 13l-4-4-7 7" />;
const SHIELD = <g><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></g>;
const CLOUD_OFF = <path d="M3 3l18 18M8 6.3A6 6 0 0 1 18 10.5 4 4 0 0 1 20.6 17M16 19H7a4.5 4.5 0 0 1-1.6-8.7" />;
const APERTURE = <g><circle cx="12" cy="12" r="9" /><path d="M14.3 3.3L9 12M20.4 8.5H10M18 17.2l-5-8.7M9.7 20.7L15 12M3.6 15.5H14M6 6.8l5 8.7" /></g>;
const GAUGE = <path d="M12 14l4-4M3.5 17a9 9 0 1 1 17 0" />;
const DATABASE = <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />;
const BUG = <path d="M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0zM12 12v6M4 13h4M16 13h4M5 7l3 2M19 7l-3 2M5 19l3-2M19 19l-3-2" />;
const BRACES = <path d="M8 4H6a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-2" />;
const SUN = <g><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></g>;

/** 受控图标名：语义入口（动作面板等）一律用这些，杜绝 emoji 键回退问题。 */
export type MobileIconName =
  | 'image'
  | 'eye'
  | 'eye-off'
  | 'pin'
  | 'edit'
  | 'link'
  | 'trash'
  | 'folder'
  | 'folder-plus'
  | 'organize'
  | 'box'
  | 'refresh'
  | 'back'
  | 'close'
  | 'more'
  | 'plus'
  | 'chevron-right'
  | 'chevron-down'
  | 'tasks'
  | 'tree'
  | 'tune'
  | 'sort'
  | 'wand'
  | 'zip'
  | 'select-all'
  | 'layers'
  | 'rotate'
  | 'info'
  | 'move'
  | 'images'
  | 'shield'
  | 'cloud-off'
  | 'aperture'
  | 'gauge'
  | 'database'
  | 'bug'
  | 'braces'
  | 'sun'
  | 'search'
  | 'grid'
  | 'list'
  | 'check'
  | 'clock'
  | 'download'
  | 'undo'
  | 'tag'
  | 'settings';

/** 图标名 → SVG 内容。 */
const ICON_PATHS: Record<MobileIconName, ReactNode> = {
  image: IMAGE,
  eye: EYE,
  'eye-off': EYE_OFF,
  pin: PIN,
  edit: EDIT,
  link: LINK,
  trash: TRASH,
  folder: FOLDER,
  'folder-plus': FOLDER_PLUS,
  organize: LIST,
  box: BOX,
  refresh: REFRESH,
  back: BACK,
  close: CLOSE,
  more: MORE,
  plus: PLUS,
  'chevron-right': CHEVRON_RIGHT,
  'chevron-down': CHEVRON_DOWN,
  tasks: TASKS,
  tree: TREE,
  tune: TUNE,
  sort: SORT,
  wand: WAND,
  zip: ZIP,
  'select-all': SELECT_ALL,
  layers: LAYERS,
  rotate: ROTATE,
  info: INFO,
  move: MOVE,
  images: IMAGES,
  shield: SHIELD,
  'cloud-off': CLOUD_OFF,
  aperture: APERTURE,
  gauge: GAUGE,
  database: DATABASE,
  bug: BUG,
  braces: BRACES,
  sun: SUN,
  search: SEARCH,
  grid: GRID,
  list: LIST,
  check: CHECK,
  clock: CLOCK,
  download: DOWNLOAD,
  undo: UNDO,
  tag: TAG,
  settings: SETTINGS,
};

/** 渲染一个受控图标。 */
export function MobileIcon({ name, className = 'w-5 h-5' }: { name: MobileIconName; className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}
