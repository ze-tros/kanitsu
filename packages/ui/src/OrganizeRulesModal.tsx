import { useMemo, useState, type FormEvent } from 'react';
import { applyCustomRule, BUILTIN_ORGANIZE_RULES, type CustomOrganizeRule } from '../../organizer/src/index';

const STORAGE_KEY = 'kanitsu-organize-custom-rules';

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

export function OrganizeRulesManager({
  rules,
  onChange,
}: {
  rules: CustomOrganizeRule[];
  onChange: (rules: CustomOrganizeRule[]) => void;
}) {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [target, setTarget] = useState('');
  const [confidence, setConfidence] = useState('0.80');
  const [sample, setSample] = useState('001_131950002_p0.jpg');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');

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
      confidence: Number.isFinite(numericConfidence) ? numericConfidence : 0.8,
      enabled: true,
    };
    if (!rule.pattern || !rule.target) return null;
    return applyCustomRule(sample, rule);
  }, [name, pattern, target, confidence, sample, editingId]);

  const resetDraft = () => {
    setName('');
    setPattern('');
    setTarget('');
    setConfidence('0.80');
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
  };

  const toggleEnabled = (id: string) => {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule)));
  };

  const deleteRule = (id: string) => {
    onChange(rules.filter((rule) => rule.id !== id));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedPattern = pattern.trim();
    const trimmedTarget = target.trim();
    const numericConfidence = Number(confidence);

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

    const nextRule: CustomOrganizeRule = {
      id: editingId ?? createRuleId(),
      name: trimmedName,
      pattern: trimmedPattern,
      target: trimmedTarget,
      confidence: Math.min(1, Math.max(0, Number.isFinite(numericConfidence) ? numericConfidence : 0.8)),
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

  return (
    <div className="flex flex-col gap-6">
      <h3 className="font-bold text-lg">整理规则</h3>
      <p className="text-sm opacity-70 mt-1">内置规则固定生效；自定义规则会优先于内置规则匹配，并自动保存到本机。</p>

        <div className="mt-5">
          <h4 className="text-sm font-semibold mb-2">内置规则</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {BUILTIN_ORGANIZE_RULES.map((rule) => (
              <div key={rule.id} className="rounded-box border border-base-300 bg-base-100 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">{rule.name}</span>
                  <span className="badge badge-sm">{rule.confidence.toFixed(2)}</span>
                </div>
                <p className="text-xs opacity-70 mt-1">{rule.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5">
          <h4 className="text-sm font-semibold mb-2">自定义规则</h4>
          {rules.length === 0 ? (
            <div className="text-sm opacity-70 border border-dashed border-base-300 rounded-box p-4 mb-4">
              还没有自定义规则。添加后会保存到本机，下次打开仍可使用。
            </div>
          ) : (
            <div className="flex flex-col gap-2 mb-4">
              {rules.map((rule) => (
                <div key={rule.id} className="rounded-box border border-base-300 bg-base-100 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm"
                        checked={rule.enabled}
                        onChange={() => toggleEnabled(rule.id)}
                      />
                      <span className="font-medium text-sm">{rule.name}</span>
                    </label>
                    <span className="badge badge-sm">{rule.confidence.toFixed(2)}</span>
                  </div>
                  <p className="text-xs opacity-70 mt-1">正则：<code>{rule.pattern}</code></p>
                  <p className="text-xs opacity-70">目标目录：<code>{rule.target}</code></p>
                  <div className="flex gap-2 mt-2">
                    <button className="btn btn-xs btn-ghost" onClick={() => startEdit(rule)}>编辑</button>
                    <button className="btn btn-xs btn-ghost text-error" onClick={() => deleteRule(rule.id)}>删除</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form className="rounded-box border border-base-300 bg-base-100 p-4 flex flex-col gap-3" onSubmit={handleSubmit}>
            <div className="text-sm font-medium">{editingId ? '编辑规则' : '添加规则'}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="form-control w-full">
                <span className="label-text text-xs">名称</span>
                <input
                  className="input input-sm input-bordered"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：Pixiv 作品 ID"
                />
              </label>
              <label className="form-control w-full">
                <span className="label-text text-xs">置信度（0–1）</span>
                <input
                  className="input input-sm input-bordered"
                  value={confidence}
                  onChange={(event) => setConfidence(event.target.value)}
                  placeholder="0.80"
                />
              </label>
              <label className="form-control w-full md:col-span-2">
                <span className="label-text text-xs">正则表达式（匹配去扩展名后的文件名）</span>
                <input
                  className="input input-sm input-bordered font-mono"
                  value={pattern}
                  onChange={(event) => setPattern(event.target.value)}
                  placeholder={'^(\\d{1,4})_(\\d{5,})_p(\\d+)$'}
                />
              </label>
              <label className="form-control w-full md:col-span-2">
                <span className="label-text text-xs">目标目录模板（$1、$2… 表示捕获组）</span>
                <input
                  className="input input-sm input-bordered font-mono"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  placeholder="$2"
                />
              </label>
            </div>

            <div className="flex flex-col gap-1">
              <label className="form-control w-full">
                <span className="label-text text-xs">测试文件名</span>
                <input
                  className="input input-sm input-bordered font-mono"
                  value={sample}
                  onChange={(event) => setSample(event.target.value)}
                  placeholder="001_131950002_p0.jpg"
                />
              </label>
              <div className="text-xs opacity-70">
                预览：
                {regexError ? (
                  <span className="text-error">{'正则表达式无效：' + regexError}</span>
                ) : preview ? (
                  <code>{preview.virtualPath}</code>
                ) : (
                  <span>不匹配或目标为空</span>
                )}
              </div>
            </div>

            {error && <div className="text-xs text-error">{error}</div>}

            <div className="flex justify-end gap-2">
              {editingId && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={resetDraft}>
                  取消编辑
                </button>
              )}
              <button className="btn btn-primary btn-sm" type="submit">
                {editingId ? '保存修改' : '添加规则'}
              </button>
            </div>
          </form>
        </div>

    </div>
  );
}
