import type { ImageEntry, OrganizeBinding } from '../../core/src/types';

export interface ParsedName {
  virtualPath: string;
  confidence: number;
  rule: string;
}

/**
 * A user-defined clustering rule. 'pattern' is a JavaScript regular expression
 * matched against the file name without its extension; 'target' is a directory
 * path template where $1, $2, ... are replaced by the regex capture groups.
 * The original file name is preserved and placed inside the resulting directory.
 */
export interface CustomOrganizeRule {
  id: string;
  name: string;
  pattern: string;
  target: string;
  confidence: number;
  enabled: boolean;
}

export interface OrganizeOptions {
  /** User-defined rules are evaluated before built-in rules, in array order. */
  customRules?: CustomOrganizeRule[];
}

export interface OrganizeRuleDescriptor {
  id: string;
  name: string;
  description: string;
  confidence: number;
}

const FULLWIDTH_SEP = /[\uff0f\uff3c\u203a\u300b|]/;

// Chinese chars used by naming rules (kept as unicode escapes to avoid encoding issues):
// \u7b2c = di4 (ordinal), \u5377 = juan3 (volume), \u8bdd/\u8a71 = hua4 (chapter),
// \u96c6 = ji2 (collection), \u5e74 = nian2 (year), \u6708 = yue4 (month), \u65e5 = ri4 (day).
const CHAPTER_RE =
  /^(.+?)[ _-]*(?:\u7b2c\s*(\d{1,4})\s*[\u5377\u8a71\u8bdd\u96c6]|[Vv][Oo][Ll][.]?\s*(\d{1,4})|(?:ch(?:apter)?|ep)\s*(\d{1,4}))[ _-]*(?:p[._ -]*(\d{1,4}))?$/;
const DATE_RE = /^(\d{4})[-_.\u5e74](\d{1,2})(?:[-_.\u6708](\d{1,2}))?\u65e5?[_ -]*(.*)$/;
const GENERIC_SERIES_RE = /^(.+?)[ _-]+(\d{2,4})$/;

// Pixiv / image-board style ids: 001_131950002_p0 -> folder "131950002".
const PIXIV_PAGE_RE = /^(\d{1,4})_(\d{5,})_p(\d{1,4})$/i;
const PIXIV_ID_RE = /^(\d{1,4})_(\d{5,})$/i;

export const BUILTIN_ORGANIZE_RULES: OrganizeRuleDescriptor[] = [
  {
    id: 'separator',
    name: '显式层级分隔符',
    description: '全角斜杠、反斜杠、›、》或 | 分隔目录',
    confidence: 0.95,
  },
  {
    id: 'date',
    name: '日期前缀',
    description: '2024-03-05_xxx → 年/月/日/xxx',
    confidence: 0.85,
  },
  {
    id: 'author',
    name: '作者标签',
    description: '[作者] 标题 → 作者/标题',
    confidence: 0.8,
  },
  {
    id: 'chapter',
    name: '卷/话/页',
    description: 'Vol.01 p001、第1话、ch01、EP4',
    confidence: 0.8,
  },
  {
    id: 'pixiv',
    name: 'Pixiv 风格编号',
    description: 'NNN_作品ID_p页码 → 作品ID/原文件名',
    confidence: 0.9,
  },
  {
    id: 'commonPrefix',
    name: '标题+编号',
    description: '标题 01 → 标题/标题 01',
    confidence: 0.6,
  },
];

function extSuffix(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx < 0 ? '' : fileName.slice(idx);
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim();
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function expandTargetTemplate(target: string, match: RegExpMatchArray): string {
  return target.replace(/\$(\d+)/g, (_, index: string) => {
    const group = match[Number(index)];
    return group === undefined ? '' : group;
  });
}

/**
 * Applies one custom rule against a file name. Returns null when the rule is
 * disabled, invalid, does not match, or would produce an unsafe path.
 */
export function applyCustomRule(fileName: string, rule: CustomOrganizeRule): ParsedName | null {
  if (!rule?.enabled) return null;
  const base = stripExtension(fileName);
  if (!base) return null;

  let regexp: RegExp;
  try {
    regexp = new RegExp(rule.pattern, 'u');
  } catch {
    return null;
  }

  const match = base.match(regexp);
  if (!match) return null;

  const expanded = expandTargetTemplate(rule.target.trim(), match);
  const dir = expanded
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.')
    .join('/');

  // applyOrganize also validates paths, but keep the preview conservative.
  if (dir.split('/').some((segment) => segment === '..')) return null;

  return {
    virtualPath: dir ? dir + '/' + fileName : fileName,
    confidence: clampConfidence(rule.confidence),
    rule: rule.name || 'custom',
  };
}

export function parseImageName(fileName: string, customRules: CustomOrganizeRule[] = []): ParsedName {
  const base = stripExtension(fileName);
  if (!base) return { virtualPath: '未分类/' + fileName, confidence: 0, rule: 'empty' };

  // User rules win over built-in rules, in the order the user listed them.
  for (const rule of customRules) {
    if (!rule.enabled) continue;
    const parsed = applyCustomRule(fileName, rule);
    if (parsed) return parsed;
  }

  // 1. Explicit hierarchy separators (fullwidth slash, backslash, raquo, etc.)
  if (FULLWIDTH_SEP.test(base)) {
    const parts = base.split(FULLWIDTH_SEP).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      return { virtualPath: parts.join('/') + extSuffix(fileName), confidence: 0.95, rule: 'separator' };
    }
  }

  // 2. Date patterns: 2024-03-05_xxx / 2024_03_05 / 2024 nian 3 yue 5 ri
  const dm = base.match(DATE_RE);
  if (dm) {
    const year = dm[1]!;
    const month = dm[2]!.padStart(2, '0');
    const day = dm[3]?.padStart(2, '0');
    const rest = dm[4]?.trim();
    const path = day ? year + '/' + month + '/' + day + '/' + rest : year + '/' + month + '/' + rest;
    return { virtualPath: path.replace(/\/+$/, '') + extSuffix(fileName), confidence: 0.85, rule: 'date' };
  }

  // 3. Author tag: [author] title
  const am = base.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (am) {
    return { virtualPath: am[1] + '/' + am[2] + extSuffix(fileName), confidence: 0.8, rule: 'author' };
  }

  // 4. Volume/chapter/page: series Vol.01 p001 / series ch001 p12 / series EP4
  const cm = base.match(CHAPTER_RE);
  if (cm) {
    const series = cm[1]!.trim();
    const num = cm[2] ?? cm[3] ?? cm[4] ?? '01';
    const page = cm[5];
    const volumeDir = series + '/Vol.' + String(num).padStart(2, '0');
    const path = page ? volumeDir + '/p' + String(page).padStart(3, '0') : volumeDir + '/' + base;
    return { virtualPath: path + extSuffix(fileName), confidence: page ? 0.9 : 0.8, rule: 'chapter' };
  }

  // 5. Pixiv-style batch ids: NNN_作品ID_p页码 or NNN_作品ID.
  // Group by the work id, keep the original file name inside that folder.
  const pixivPage = base.match(PIXIV_PAGE_RE);
  if (pixivPage) {
    return { virtualPath: pixivPage[2] + '/' + fileName, confidence: 0.9, rule: 'pixiv' };
  }
  const pixivId = base.match(PIXIV_ID_RE);
  if (pixivId) {
    return { virtualPath: pixivId[2] + '/' + fileName, confidence: 0.85, rule: 'pixiv' };
  }

  // 6. Generic series-number: Title 01
  const gm = base.match(GENERIC_SERIES_RE);
  if (gm) {
    return { virtualPath: gm[1].trim() + '/' + base + extSuffix(fileName), confidence: 0.6, rule: 'commonPrefix' };
  }

  // 7. Conservative fallback
  return { virtualPath: '未分类/' + fileName, confidence: 0.2, rule: 'fallback' };
}

export function organizeImages(images: ImageEntry[], options: OrganizeOptions = {}): OrganizeBinding[] {
  const customRules = options.customRules ?? [];
  return images.map((image) => {
    const parsed = parseImageName(image.name, customRules);
    return {
      imageId: image.id,
      virtualPath: parsed.virtualPath,
      confidence: parsed.confidence,
      materialized: false,
    };
  });
}

export function organizeByFolder(images: ImageEntry[], options: OrganizeOptions = {}): OrganizeBinding[] {
  return organizeImages(images, options);
}
