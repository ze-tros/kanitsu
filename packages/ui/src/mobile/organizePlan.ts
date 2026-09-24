/**
 * 移动端智能整理的两步流程（选规则 → 预览分组）所需的纯逻辑。
 *
 * 解析仍由 organizer.parseImageName 完成（自定义规则优先），这里只做：
 * - 按命中规则统计每条规则能整理多少张（低于落盘阈值的不计，与 applyOrganize 一致）；
 * - 只保留所选规则命中的绑定（其余图片保持原位）；
 * - 按目标目录把绑定聚成预览分组，并支持重命名分组。
 */
import type { ImageEntry, OrganizeBinding } from '../../../core/src/index';
import {
  BUILTIN_ORGANIZE_RULES,
  parseImageName,
  type CustomOrganizeRule,
} from '../../../organizer/src/index';

/** 与 applyOrganize 默认 confidenceThreshold 一致：低于它的绑定不会落盘。 */
export const ORGANIZE_CONFIDENCE_THRESHOLD = 0.5;
/** 「自动」= 所有规则按优先级依次匹配（原有整理行为）。 */
export const AUTO_RULE_ID = 'auto';

export interface RuleOption {
  id: string;
  name: string;
  description: string;
  /** 自定义规则 or 内置规则 or 自动。 */
  kind: 'auto' | 'custom' | 'builtin';
  hitCount: number;
}

export interface PlannedBinding extends OrganizeBinding {
  /** 命中的规则 id（内置规则 id，或自定义规则的名称）。 */
  rule: string;
}

export interface PreviewGroup {
  /** 目标目录（相对整理容器），如 "第02话" 或 "2025/07/14"。 */
  dir: string;
  bindings: PlannedBinding[];
}

export function planBindings(images: readonly ImageEntry[], customRules: CustomOrganizeRule[]): PlannedBinding[] {
  return images.map((image) => {
    const parsed = parseImageName(image.name, customRules);
    return {
      imageId: image.id,
      virtualPath: parsed.virtualPath,
      confidence: parsed.confidence,
      materialized: false,
      rule: parsed.rule,
    };
  });
}

const isApplicable = (b: PlannedBinding): boolean => b.confidence >= ORGANIZE_CONFIDENCE_THRESHOLD;

/** 规则选项：自动 + 启用的自定义规则 + 内置规则，附命中数（自动 = 全部可落盘的绑定）。 */
export function ruleOptions(bindings: readonly PlannedBinding[], customRules: CustomOrganizeRule[]): RuleOption[] {
  const hits = new Map<string, number>();
  let total = 0;
  for (const b of bindings) {
    if (!isApplicable(b)) continue;
    total++;
    hits.set(b.rule, (hits.get(b.rule) ?? 0) + 1);
  }
  const custom = customRules
    .filter((r) => r.enabled)
    .map<RuleOption>((r) => ({
      id: r.name || 'custom',
      name: r.name || '自定义规则',
      description: `${r.pattern} → ${r.target}`,
      kind: 'custom',
      hitCount: hits.get(r.name || 'custom') ?? 0,
    }));
  const builtin = BUILTIN_ORGANIZE_RULES.map<RuleOption>((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    kind: 'builtin',
    hitCount: hits.get(r.id) ?? 0,
  }));
  return [
    { id: AUTO_RULE_ID, name: '自动匹配', description: '按优先级依次尝试全部规则（自定义规则优先）', kind: 'auto', hitCount: total },
    ...custom,
    ...builtin,
  ];
}

/** 所选规则下会移动的绑定；其余图片保持原位。 */
export function bindingsForRule(bindings: readonly PlannedBinding[], ruleId: string): PlannedBinding[] {
  return bindings.filter((b) => isApplicable(b) && (ruleId === AUTO_RULE_ID || b.rule === ruleId));
}

function dirOf(virtualPath: string): string {
  const i = virtualPath.lastIndexOf('/');
  return i < 0 ? '' : virtualPath.slice(0, i);
}

/**
 * 预览分组：按目标目录聚合，目录名自然排序。目标就在容器根下（无目录）的绑定
 * 实际不会移动位置，不单独成组。
 */
export function previewGroups(bindings: readonly PlannedBinding[]): PreviewGroup[] {
  const map = new Map<string, PlannedBinding[]>();
  for (const b of bindings) {
    const dir = dirOf(b.virtualPath);
    if (!dir) continue;
    const list = map.get(dir);
    if (list) list.push(b);
    else map.set(dir, [b]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN', { numeric: true }))
    .map(([dir, list]) => ({ dir, bindings: list }));
}

/** 把目录 from（及其子路径）改名为 to；to 经过分段清洗，空值或含 .. 时原样返回。 */
export function renameGroup(bindings: readonly PlannedBinding[], from: string, to: string): PlannedBinding[] {
  const target = to
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.')
    .join('/');
  if (!target || target.split('/').includes('..') || target === from) return [...bindings];
  return bindings.map((b) => {
    if (b.virtualPath.startsWith(from + '/')) return { ...b, virtualPath: target + b.virtualPath.slice(from.length) };
    return b;
  });
}
