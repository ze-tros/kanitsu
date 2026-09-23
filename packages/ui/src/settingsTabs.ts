/**
 * 设置页标签页的纯数据与筛选逻辑（不依赖 React，便于单测）。
 *
 * keywords 收录各标签页正文里出现的可检索词：搜索框按「标签名 + 页标题 + 关键词」
 * 做子串匹配，因此页面上真实存在的文案（如「主题色」「图库占用」「运行诊断」）都能搜到，
 * 不再依赖一份和 UI 脱节的硬编码字符串。
 */
import { ACCENT_OPTIONS } from './accents';

export type SettingsTabId = 'general' | 'organize' | 'debug' | 'cache';

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
    id: 'general',
    label: '通用',
    title: '界面与主题',
    keywords: [
      '界面与主题', '外观', '界面模式', '深色', '浅色', '跟随系统', '主题色',
      // 主题色的显示名直接取自共享清单，避免改名后搜索失效。
      ...ACCENT_OPTIONS.map((option) => option.label),
      'RAW 显示', 'RAW 观感', '内嵌预览', '完整解码', 'raw', 'arw', 'cr3', 'nef',
      '应用', '运行环境', '图库占用', '自定义整理规则',
      '数据目录', '保存位置', '保存路径', '复制一份', 'albums',
    ],
  },
  {
    id: 'organize',
    label: '整理规则',
    title: '整理规则',
    keywords: [
      '整理规则', '自定义整理规则', '规则', '智能整理',
      '内置规则', '自定义规则', '正则表达式', '置信度', '目标目录模板', '测试文件名',
    ],
  },
  {
    id: 'debug',
    label: '调试',
    title: '运行诊断',
    keywords: [
      '运行诊断', '帧率', '帧间隔', 'fps', '掉帧', '卡顿', '滚动', '滚动回调', '调试选项',
      '日志', '日志等级', '缩略图缓存', '队列积压', '解码', 'worker', '主进程缓存',
      '磁盘缓存', '样本',
    ],
  },
  {
    id: 'cache',
    label: '缓存',
    title: '缓存管理',
    keywords: [
      '缓存管理', '缩略图缓存', '内存缓存', '磁盘缓存', '清理缓存', '命中率', '未命中',
      '缓存条目', '容量上限', '预取',
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
