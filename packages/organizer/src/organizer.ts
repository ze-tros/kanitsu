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

// —— 自定义规则正则的回溯安全校验 ——
// 用户输入的正则直接在主线程执行，灾难性回溯（ReDoS）会冻结整个界面且无法
// 中止。两层防护：静态启发式拒绝典型嵌套无界量词形态；再用对抗样本做限时
// 试跑，超时即判为高危。结果按 pattern 缓存，避免逐张图片重复探测。

export interface PatternSafety {
  ok: boolean;
  /** 不安全/非法时的说明（供规则编辑器展示）。 */
  reason?: string;
}

const MAX_PATTERN_LENGTH = 500;
/** 单个对抗样本的匹配耗时上限（毫秒）。 */
const PROBE_BUDGET_MS = 24;

/**
 * 静态启发式：捕获/非捕获组自身被无界量词（`*` `+` `{n,}`）修饰，且组内也出现
 * 过无界量词时命中（典型如 `(a+)+`、`((a+)b)+`）。
 */
function hasNestedQuantifier(pattern: string): boolean {
  // 记录每层组内是否出现过无界量词；出组时若该组被无界量词修饰即命中。
  const nested = new Set<number>();
  let depth = 0;
  let i = 0;
  const skipClass = (): void => {
    i++; // '['
    if (pattern[i] === '^') i++;
    if (pattern[i] === ']') i++;
    while (i < pattern.length && pattern[i] !== ']') {
      if (pattern[i] === '\\') i++;
      i++;
    }
    i++; // ']'
  };
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      skipClass();
      continue;
    }
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      const closeDepth = depth;
      depth--;
      i++;
      let j = i;
      if (pattern[j] === '?') j++; // 可选组 / 非贪婪标记
      if ((pattern[j] === '*' || pattern[j] === '+') && nested.has(closeDepth)) return true;
      if (pattern[j] === '{') {
        const close = pattern.indexOf('}', j);
        const body = close > j ? pattern.slice(j + 1, close) : '';
        if (/,\s*$/.test(body) && nested.has(closeDepth)) return true;
      }
      continue;
    }
    if (ch === '*' || ch === '+') {
      nested.add(depth);
      i++;
      continue;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      const body = close > i ? pattern.slice(i + 1, close) : '';
      if (/^\d+,\s*$/.test(body)) nested.add(depth);
      i = close > i ? close + 1 : i + 1;
      continue;
    }
    i++;
  }
  return false;
}

/** 从 pattern 里抽出字面字符（字符类/转义之外），用于构造对抗样本。 */
function patternLiteralChars(pattern: string): string {
  const chars: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (/[a-z0-9]/i.test(ch)) chars.push(ch);
    i++;
  }
  return [...new Set(chars)].join('');
}

/** 限时试跑：样本呈超线性耗时（疑似灾难性回溯）时返回 true。 */
function probePatternUnsafe(regexp: RegExp): boolean {
  const literals = patternLiteralChars(regexp.source) || 'a';
  const units = literals.slice(0, 2);
  for (const n of [16, 22]) {
    const subject = units.repeat(Math.ceil(n / units.length)).slice(0, n) + '!';
    const start = performance.now();
    try {
      regexp.test(subject);
    } catch {
      return true;
    }
    if (performance.now() - start > PROBE_BUDGET_MS) return true;
  }
  return false;
}

const patternSafetyCache = new Map<string, PatternSafety>();

/** 校验自定义规则的 pattern：语法合法、长度有界、且没有灾难性回溯风险。 */
export function validateCustomRulePattern(pattern: string): PatternSafety {
  const cached = patternSafetyCache.get(pattern);
  if (cached) return cached;
  let result: PatternSafety;
  if (!pattern.trim()) {
    result = { ok: false, reason: '正则表达式为空' };
  } else if (pattern.length > MAX_PATTERN_LENGTH) {
    result = { ok: false, reason: `正则表达式过长（超过 ${MAX_PATTERN_LENGTH} 字符）` };
  } else {
    try {
      const regexp = new RegExp(pattern, 'u');
      if (hasNestedQuantifier(pattern)) {
        result = { ok: false, reason: '正则包含嵌套无界量词（如 (a+)+），可能导致灾难性回溯' };
      } else if (probePatternUnsafe(regexp)) {
        result = { ok: false, reason: '正则在对抗样本上耗时异常，疑似灾难性回溯' };
      } else {
        result = { ok: true };
      }
    } catch {
      result = { ok: false, reason: '正则表达式无效' };
    }
  }
  if (patternSafetyCache.size > 100) patternSafetyCache.clear();
  patternSafetyCache.set(pattern, result);
  return result;
}

/**
 * Applies one custom rule against a file name. Returns null when the rule is
 * disabled, invalid, unsafe, does not match, or expands to no target directory
 * (target 展开为空时按「不匹配」处理，回落到内置规则，保证预览与落盘口径一致）。
 */
export function applyCustomRule(fileName: string, rule: CustomOrganizeRule): ParsedName | null {
  if (!rule?.enabled) return null;
  const base = stripExtension(fileName);
  if (!base) return null;

  if (!validateCustomRulePattern(rule.pattern).ok) return null;

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
  // 目录为空 = 无处可去：统一视为不匹配，回落到内置规则。
  if (!dir) return null;

  return {
    virtualPath: dir + '/' + fileName,
    confidence: clampConfidence(rule.confidence),
    // 返回规则 id（唯一）而不是名称：重名规则不会在命中统计与选中行为上互相串台，
    // 名称只作展示文本（展示层按 id 反查）。
    rule: rule.id,
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
