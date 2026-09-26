import { useMemo, useRef, useState, type FormEvent } from 'react';
import { applyCustomRule, BUILTIN_ORGANIZE_RULES, type CustomOrganizeRule } from '../../organizer/src/index';

const STORAGE_KEY = 'kanitsu-organize-custom-rules';

/** 低于该置信度的绑定会在整理时被跳过（core/organize.ts 的默认阈值）。 */
const LOW_CONFIDENCE = 0.5;
const DEFAULT_CONFIDENCE = 0.8;

function isValidCustomRule(value: unknown): value is CustomOrganizeRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<CustomOrganizeRule>;
  return (
    typeof rule.id === 'string' &&
    typeof rule.name === 'string' &&
    typeof rule.pattern === 'string' &&
    typeof rule.target === 'string' &&
    typeof rule.confidence === 'number' &&
    typeof rule.enabled === 'boolean'
  );
}

export function loadCustomRules(): CustomOrganizeRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidCustomRule);
  } catch {
    return [];
  }
}

export function saveCustomRules(rules: CustomOrganizeRule[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch {
    // Ignore storage errors (private mode, disabled localStorage, etc.).
  }
}

function createRuleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'rule-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

/**
 * 整理规则面板（移动端设置页）：内置规则（只读参考）+ 自定义规则（增删改）+ 规则编辑器。
 *
 * 样式在 mobile.css 的 `.m-settings-rules` 下收口。桌面设置页用的是 desktop/RulesPanel，
 * 两端只共享这里的 loadCustomRules / saveCustomRules 与 organizer 的匹配逻辑。
 */
export function OrganizeRulesManager({
  rules,
  onChange,
  showIntro = true,
  className,
}: {
  rules: CustomOrganizeRule[];
  onChange: (rules: CustomOrganizeRule[]) => void;
  /** 调用方已经给出同一句说明（如移动端的设置卡片）时关掉，避免重复两遍。 */
  showIntro?: boolean;
  className?: string;
}) {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [target, setTarget] = useState('');
  const [confidence, setConfidence] = useState(DEFAULT_CONFIDENCE.toFixed(2));
  const [sample, setSample] = useState('001_131950002_p0.jpg');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const editing = editingId != null;

  const regexError = useMemo(() => {
    const trimmed = pattern.trim();
    if (!trimmed) return '';
    try {
      new RegExp(trimmed, 'u');
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [pattern]);

  const preview = useMemo(() => {
    const numericConfidence = Number(confidence);
    const rule: CustomOrganizeRule = {
      id: editingId ?? 'preview',
      name: name.trim() || '预览规则',
      pattern: pattern.trim(),
      target: target.trim(),
      confidence: Number.isFinite(numericConfidence) ? numericConfidence : DEFAULT_CONFIDENCE,
      enabled: true,
    };
    if (!rule.pattern || !rule.target) return null;
    return applyCustomRule(sample, rule);
  }, [name, pattern, target, confidence, sample, editingId]);

  const resetDraft = () => {
    setName('');
    setPattern('');
    setTarget('');
    setConfidence(DEFAULT_CONFIDENCE.toFixed(2));
    setEditingId(null);
    setError('');
  };

  const startEdit = (rule: CustomOrganizeRule) => {
    setName(rule.name);
    setPattern(rule.pattern);
    setTarget(rule.target);
    setConfidence(rule.confidence.toFixed(2));
    setEditingId(rule.id);
    setError('');
    // 规则列表长于视口时，编辑器在屏幕外，滚过去让「正在编辑」可见。
    // 尊重系统的减弱动效偏好：直接跳转，不做平滑滚动。
    const reduceMotion = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    formRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  };

  const toggleEnabled = (id: string) => {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule)));
  };

  const deleteRule = (id: string) => {
    onChange(rules.filter((rule) => rule.id !== id));
    if (editingId === id) resetDraft();
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedPattern = pattern.trim();
    const trimmedTarget = target.trim();
    const trimmedConfidence = confidence.trim();
    const numericConfidence = trimmedConfidence === '' ? DEFAULT_CONFIDENCE : Number(trimmedConfidence);

    if (!trimmedName) {
      setError('请输入规则名称。');
      return;
    }
    if (!trimmedPattern) {
      setError('请输入正则表达式。');
      return;
    }
    if (regexError) {
      setError('正则表达式无效：' + regexError);
      return;
    }
    if (!trimmedTarget) {
      setError('请输入目标目录模板。');
      return;
    }
    if (!Number.isFinite(numericConfidence) || numericConfidence < 0 || numericConfidence > 1) {
      setError('置信度需要是 0 到 1 之间的数字。');
      return;
    }

    const nextRule: CustomOrganizeRule = {
      id: editingId ?? createRuleId(),
      name: trimmedName,
      pattern: trimmedPattern,
      target: trimmedTarget,
      confidence: numericConfidence,
      enabled: true,
    };

    if (editingId) {
      onChange(
        rules.map((rule) => (rule.id === editingId ? { ...nextRule, enabled: rule.enabled } : rule)),
      );
    } else {
      onChange([...rules, nextRule]);
    }

    resetDraft();
  };

  const previewState = regexError ? 'is-invalid' : preview ? 'is-hit' : 'is-miss';

  return (
    <div className={`organize-rules-manager flex flex-col gap-6 ${className ?? ''}`}>
      {showIntro && (
        <p className="organize-rules-intro text-sm opacity-70">
          内置规则固定生效；自定义规则会优先于内置规则匹配，并自动保存到本机。
        </p>
      )}

      <section className="organize-rules-section is-builtin">
        <header className="organize-rules-heading">
          <h2 className="organize-rules-subtitle">内置规则</h2>
          <p className="organize-rules-hint">
            固定生效、不可编辑；按下列顺序在自定义规则之后依次尝试，未被匹配的文件保持原位。
          </p>
        </header>
        <div className="organize-rules-list grid grid-cols-1 md:grid-cols-2 gap-2">
          {BUILTIN_ORGANIZE_RULES.map((rule) => (
            <div key={rule.id} className="organize-rule-card rounded-box border border-base-300 bg-base-100 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm">{rule.name}</span>
                <span className="organize-rule-score badge badge-sm">{rule.confidence.toFixed(2)}</span>
              </div>
              <p className="text-xs opacity-70 mt-1">{rule.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="organize-rules-section is-custom">
        <header className="organize-rules-heading">
          <h2 className="organize-rules-subtitle">自定义规则</h2>
          <p className="organize-rules-hint">
            按列表顺序优先匹配；取消勾选可临时停用某条规则而不删除。
          </p>
        </header>

        {rules.length === 0 ? (
          <p className="organize-rules-empty text-sm opacity-70 border border-dashed border-base-300 rounded-box p-4 mb-4">
            还没有自定义规则。用下面的表单添加第一条，它会保存在本机，下次打开仍可使用。
          </p>
        ) : (
          <div className="organize-rules-list flex flex-col gap-2 mb-4">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className={`organize-rule-card rounded-box border border-base-300 bg-base-100 p-3${
                  rule.enabled ? '' : ' is-disabled'
                }${editingId === rule.id ? ' is-editing' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="organize-rule-checkbox checkbox checkbox-sm"
                      checked={rule.enabled}
                      onChange={() => toggleEnabled(rule.id)}
                    />
                    <span className="font-medium text-sm">{rule.name}</span>
                  </label>
                  <span className="organize-rule-score badge badge-sm">
                    <span className="sr-only">置信度</span>
                    {rule.confidence.toFixed(2)}
                  </span>
                </div>
                <p className="organize-rule-meta text-xs opacity-70 mt-1">
                  <span className="organize-rule-meta-label">正则：</span>
                  <code>{rule.pattern}</code>
                </p>
                <p className="organize-rule-meta text-xs opacity-70">
                  <span className="organize-rule-meta-label">目标目录：</span>
                  <code>{rule.target}</code>
                </p>
                <div className="organize-rule-actions flex gap-2 mt-2">
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    aria-label={`编辑规则「${rule.name}」`}
                    onClick={() => startEdit(rule)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost text-error"
                    aria-label={`删除规则「${rule.name}」`}
                    onClick={() => deleteRule(rule.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="organize-rules-section is-editor">
        <header className="organize-rules-heading">
          <h2 className="organize-rules-subtitle">{editing ? '编辑规则' : '添加规则'}</h2>
          <p className="organize-rules-hint">
            {editing
              ? `正在编辑「${name.trim() || '未命名规则'}」；保存修改会覆盖原规则。`
              : '正则表达式匹配去掉扩展名后的文件名；目标目录模板里的 $1、$2 会替换为对应的捕获组。'}
          </p>
        </header>

        <form
          ref={formRef}
          className="organize-rule-form rounded-box border border-base-300 bg-base-100 p-4 flex flex-col gap-3"
          onSubmit={handleSubmit}
        >
          <div className="organize-rule-fields grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="organize-rule-field w-full">
              <span>
                名称
                <span className="organize-rule-field-hint">用于辨认这条规则</span>
              </span>
              <input
                className="organize-rule-input input input-sm input-bordered"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：Pixiv 作品 ID"
              />
            </label>
            <label className="organize-rule-field w-full">
              <span>
                置信度
                <span className="organize-rule-field-hint">{`0–1，低于 ${LOW_CONFIDENCE} 的文件整理时保留原位`}</span>
              </span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                inputMode="decimal"
                className="organize-rule-input input input-sm input-bordered"
                value={confidence}
                onChange={(event) => setConfidence(event.target.value)}
                placeholder="0.80"
              />
            </label>
            <label className="organize-rule-field w-full is-wide">
              <span>
                正则表达式
                <span className="organize-rule-field-hint">匹配去掉扩展名后的文件名</span>
              </span>
              <input
                className={`organize-rule-input input input-sm input-bordered font-mono${
                  regexError ? ' is-invalid' : ''
                }`}
                value={pattern}
                onChange={(event) => setPattern(event.target.value)}
                placeholder={'^(\\d{1,4})_(\\d{5,})_p(\\d+)$'}
                aria-invalid={regexError ? true : undefined}
              />
            </label>
            <label className="organize-rule-field w-full is-wide">
              <span>
                目标目录模板
                <span className="organize-rule-field-hint">$1、$2… 表示正则的捕获组</span>
              </span>
              <input
                className="organize-rule-input input input-sm input-bordered font-mono"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="$2"
              />
            </label>
          </div>

          <div className="organize-rule-preview flex flex-col gap-1">
            <label className="organize-rule-field w-full">
              <span>测试文件名</span>
              <input
                className="organize-rule-input input input-sm input-bordered font-mono"
                value={sample}
                onChange={(event) => setSample(event.target.value)}
                placeholder="001_131950002_p0.jpg"
              />
            </label>
            <div className={`organize-rule-preview-result ${previewState}`} aria-live="polite">
              <span className="organize-rule-preview-label">预览</span>
              {regexError ? (
                <span className="text-error">正则表达式无效：{regexError}</span>
              ) : preview ? (
                <code>{preview.virtualPath}</code>
              ) : (
                <span className="organize-rule-preview-empty">不匹配或目标目录为空</span>
              )}
            </div>
          </div>

          {error && (
            <div className="organize-rule-error text-xs text-error" role="alert">
              {error}
            </div>
          )}

          <div className="organize-rule-form-actions flex justify-end gap-2">
            {editing && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={resetDraft}>
                取消编辑
              </button>
            )}
            <button className="btn btn-primary btn-sm" type="submit">
              {editing ? '保存修改' : '添加规则'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
