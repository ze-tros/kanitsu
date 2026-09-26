/**
 * 设置页标签页的纯数据与筛选逻辑（不依赖 React，便于单测）。
 *
 * keywords 收录各标签页正文里出现的可检索词：搜索框按「标签名 + 页标题 + 关键词」
 * 做子串匹配，因此页面上真实存在的文案（如「主题色」「图库占用」「运行诊断」）都能搜到，
 * 不再依赖一份和 UI 脱节的硬编码字符串。
 */
import { ACCENT_OPTIONS } from './accents';
import { DESKTOP_SHORTCUTS } from './desktopShortcuts';

export type SettingsTabId =
  | 'appearance'
  | 'library'
  | 'viewer'
  | 'rules'
  | 'cache'
  | 'diagnostics'
  | 'shortcuts'
  | 'about';

export interface SettingsTab {
  id: SettingsTabId;
  /** 侧栏导航里的短标签。 */
  label: string;
  /** 正文页标题。 */
  title: string;
  /** 该页正文里出现的关键词。 */
  keywords: readonly string[];
}

export const SETTINGS_TABS: ReadonlyArray<SettingsTab> = [
  {
    id: 'appearance',
    label: '外观',
    title: '外观',
    keywords: [
      '主题', '界面模式', '深色', '浅色', '跟随系统', '主题色', '强调色',
      // 主题色的显示名直接取自共享清单，避免改名后搜索失效。
      ...ACCENT_OPTIONS.map((option) => option.label),
    ],
  },
  {
    id: 'library',
    label: '图库与数据',
    title: '图库与数据',
    keywords: [
      '数据目录', '保存位置', '保存路径', '复制一份', 'albums',
      '图库占用', '文件数', '运行环境', '自定义整理规则',
    ],
  },
  {
    id: 'viewer',
    label: '查看器',
    title: '查看器',
    keywords: [
      'RAW 显示', 'RAW 观感', '显影', '直出', '内嵌预览', '完整解码', '相机直出',
      'raw', 'arw', 'cr3', 'nef', '原图',
    ],
  },
  {
    id: 'rules',
    label: '整理规则',
    title: '整理规则',
    keywords: [
      '自定义整理规则', '规则', '智能整理',
      '内置规则', '自定义规则', '正则表达式', '置信度', '目标目录模板', '测试文件名',
    ],
  },
  {
    id: 'cache',
    label: '缓存',
    title: '缓存',
    keywords: [
      '缓存管理', '缩略图缓存', '渲染端', '内存缓存', '主进程缓存', '磁盘缓存', '清理缓存',
      '命中率', '未命中', '缓存条目', '容量上限', '预取已排', '预取完成', '预取失败',
    ],
  },
  {
    id: 'diagnostics',
    label: '诊断',
    title: '诊断',
    keywords: [
      '运行诊断', '帧率', '帧间隔', 'fps', '掉帧', '卡顿', '滚动', '滚动回调', '样本',
      '缩略图队列', '队列积压', '解码', 'worker',
      '调试选项', '日志', '日志等级', '后台预取', '主进程日志', '渲染端日志',
    ],
  },
  {
    id: 'shortcuts',
    label: '快捷键',
    title: '快捷键',
    keywords: [
      '键盘', '快捷键', '按键',
      // 速查表里的分组名与动作名都能搜到。
      ...DESKTOP_SHORTCUTS.flatMap((group) => [group.title, ...group.items.map((item) => item.label)]),
    ],
  },
  {
    id: 'about',
    label: '关于',
    title: '关于',
    keywords: [
      'Kanitsu', '版本', '运行环境', '隐私', '离线', '不联网', '不上传', '遥测',
      '副本隔离', '源文件夹',
    ],
  },
];

/** 双向子串匹配：`主题` 命中「主题色」，`累计掉帧` 命中关键词「掉帧」。空查询命中全部。 */
function matches(haystack: string, query: string): boolean {
  const text = haystack.toLowerCase();
  return text.includes(query) || query.includes(text);
}

/** 大小写不敏感的子串匹配；空查询视为命中全部。 */
export function settingsTabMatches(tab: SettingsTab, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return matches(tab.label, normalized)
    || matches(tab.title, normalized)
    || tab.keywords.some((keyword) => matches(keyword, normalized));
}

/**
 * 过滤标签页，但当前标签页始终保留：否则搜索会把正在显示的标签页从导航里删掉，
 * 出现「正文还在渲染、导航里没有对应项」的割裂状态。
 */
export function filterSettingsTabs(
  query: string,
  activeTab: SettingsTabId,
): ReadonlyArray<SettingsTab> {
  return SETTINGS_TABS.filter((tab) => tab.id === activeTab || settingsTabMatches(tab, query));
}

/** 是否存在任何命中（供空状态提示使用）。 */
export function hasSettingsTabMatches(query: string): boolean {
  return SETTINGS_TABS.some((tab) => settingsTabMatches(tab, query));
}
