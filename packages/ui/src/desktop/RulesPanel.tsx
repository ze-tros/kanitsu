/**
 * 桌面设置页「整理规则」：对应 demo 的两张卡片——内置规则（逐行说明）与自定义规则
 * （表格 + 文件名测试行 + 新建）。规则的新建 / 编辑在对话框里完成。
 *
 * 移动端仍用 OrganizeRulesModal 的 OrganizeRulesManager；两端只共享规则的数据与匹配逻辑。
 */
import { useMemo, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MagnifyingGlass, PencilSimple, Plus } from '@phosphor-icons/react';
import {
  applyCustomRule,
  BUILTIN_ORGANIZE_RULES,
  parseImageName,
  type CustomOrganizeRule,
} from '../../../organizer/src/index';
import { Switch } from './controls';
import { DialogFrame } from './Dialogs';

/** 低于该置信度的绑定在整理时保持原位（core/organize.ts 的默认阈值）。 */
const LOW_CONFIDENCE = 0.5;
const DEFAULT_CONFIDENCE = 0.8;
const DEFAULT_SAMPLE = '001_131950002_p0.jpg';

function createRuleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'rule-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function regexErrorOf(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed) return '';
  try {
    new RegExp(trimmed, 'u');
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const BUILTIN_NAMES = new Map(BUILTIN_ORGANIZE_RULES.map((rule) => [rule.id, rule.name]));

type EditorState = { rule: CustomOrganizeRule | null };

export function RulesPanel({
  rules,
  onChange,
}: {
  rules: CustomOrganizeRule[];
  onChange: (rules: CustomOrganizeRule[]) => void;
}) {
  const [sample, setSample] = useState(DEFAULT_SAMPLE);
  const [editor, setEditor] = useState<EditorState | null>(null);

  // 测试行按整理时的真实顺序匹配：先自定义规则，再内置规则；低置信度的结果整理时保持原位。
  const test = useMemo(() => {
    const name = sample.trim();
    if (!name) return null;
    const parsed = parseImageName(name, rules);
    if (parsed.confidence < LOW_CONFIDENCE) return { hit: false as const };
    return { hit: true as const, path: parsed.virtualPath, rule: BUILTIN_NAMES.get(parsed.rule) ?? parsed.rule };
  }, [rules, sample]);

  const toggleEnabled = (id: string) => {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule)));
  };

  const saveRule = (next: CustomOrganizeRule) => {
    const exists = rules.some((rule) => rule.id === next.id);
    onChange(exists ? rules.map((rule) => (rule.id === next.id ? next : rule)) : [...rules, next]);
  };

  const deleteRule = (id: string) => onChange(rules.filter((rule) => rule.id !== id));

  return (
    <>
      <section className="dk-set-card">
        <h3 className="dk-set-card-title">内置规则</h3>
        {BUILTIN_ORGANIZE_RULES.map((rule) => (
          <div key={rule.id} className="dk-set-row">
            <div className="dk-set-row-label">
              <b>{rule.name}</b>
              <small>{rule.description}</small>
            </div>
            <div className="dk-set-row-control">
              {/* 内置规则固定生效：开关只表达状态，不可切换。 */}
              <Switch checked locked label={`${rule.name}：固定启用`} title="内置规则固定启用" />
            </div>
          </div>
        ))}
      </section>

      <section className="dk-set-card">
        <h3 className="dk-set-card-title">自定义规则</h3>
        <table className="dk-set-rules-t">
          <thead>
            <tr>
              <th>名称</th>
              <th>模式</th>
              <th>目标目录</th>
              <th><span className="dk-sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={4} className="is-empty">还没有自定义规则。自定义规则按列表顺序、先于内置规则匹配。</td>
              </tr>
            ) : (
              rules.map((rule) => (
                <tr key={rule.id} className={rule.enabled ? '' : 'is-off'}>
                  <td>{rule.name}</td>
                  <td><code>{rule.pattern}</code></td>
                  <td><code>{rule.target}</code></td>
                  <td className="is-act">
                    <Switch
                      checked={rule.enabled}
                      label={`启用规则「${rule.name}」`}
                      title={rule.enabled ? '停用' : '启用'}
                      onChange={() => toggleEnabled(rule.id)}
                    />
                    <button
                      type="button"
                      className="dk-ib"
                      aria-label={`编辑规则「${rule.name}」`}
                      title="编辑"
                      onClick={() => setEditor({ rule })}
                    >
                      <PencilSimple size={14} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="dk-set-row dk-set-rules-test">
          <label className="dk-field">
            <MagnifyingGlass size={13} aria-hidden="true" />
            <input
              value={sample}
              spellCheck={false}
              onChange={(event) => setSample(event.target.value)}
              placeholder="输入文件名测试规则"
              aria-label="测试文件名"
            />
          </label>
          <span className="dk-set-rules-result" aria-live="polite">
            {test == null ? '' : test.hit ? (
              <>→ <code>{test.path}</code><small>{test.rule}</small></>
            ) : '→ 保持原位（未命中规则）'}
          </span>
          <button type="button" className="dk-btn sm" onClick={() => setEditor({ rule: null })}>
            <Plus size={13} aria-hidden="true" />新建规则
          </button>
        </div>
      </section>

      {/* 设置页挂在 .dk-body 里；对话框挂到 .dk-root，遮罩才能盖住标题栏，模态期间标题栏不可点。 */}
      {editor && createPortal(
        <RuleEditorDialog
          rule={editor.rule}
          sample={sample}
          onSave={saveRule}
          onDelete={deleteRule}
          onClose={() => setEditor(null)}
        />,
        document.querySelector('.dk-root') ?? document.body,
      )}
    </>
  );
}

function RuleEditorDialog({
  rule,
  sample: initialSample,
  onSave,
  onDelete,
  onClose,
}: {
  rule: CustomOrganizeRule | null;
  sample: string;
  onSave: (rule: CustomOrganizeRule) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? '');
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [target, setTarget] = useState(rule?.target ?? '');
  const [confidence, setConfidence] = useState((rule?.confidence ?? DEFAULT_CONFIDENCE).toFixed(2));
  const [sample, setSample] = useState(initialSample || DEFAULT_SAMPLE);
  const [error, setError] = useState('');

  const regexError = regexErrorOf(pattern);
  const preview = useMemo(() => {
    if (regexError || !pattern.trim() || !target.trim()) return null;
    return applyCustomRule(sample, {
      id: 'preview',
      name: name.trim() || '预览规则',
      pattern: pattern.trim(),
      target: target.trim(),
      confidence: DEFAULT_CONFIDENCE,
      enabled: true,
    });
  }, [name, pattern, regexError, sample, target]);

  const submit = () => {
    const trimmedConfidence = confidence.trim();
    const numericConfidence = trimmedConfidence === '' ? DEFAULT_CONFIDENCE : Number(trimmedConfidence);
    if (!name.trim()) return setError('请输入规则名称。');
    if (!pattern.trim()) return setError('请输入正则表达式。');
    if (regexError) return setError('正则表达式无效：' + regexError);
    if (!target.trim()) return setError('请输入目标目录模板。');
    if (!Number.isFinite(numericConfidence) || numericConfidence < 0 || numericConfidence > 1) {
      return setError('置信度需要是 0 到 1 之间的数字。');
    }
    onSave({
      id: rule?.id ?? createRuleId(),
      name: name.trim(),
      pattern: pattern.trim(),
      target: target.trim(),
      confidence: numericConfidence,
      enabled: rule?.enabled ?? true,
    });
    onClose();
  };

  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  return (
    <DialogFrame label={rule ? '编辑规则' : '新建规则'} className="dk-redit" onClose={onClose}>
      <div className="dk-dlg-h">
        <h2>{rule ? '编辑规则' : '新建规则'}</h2>
        <p>正则表达式匹配去掉扩展名后的文件名；目标目录里的 $1、$2 替换为对应的捕获组。</p>
      </div>
      <div className="dk-dlg-b dk-redit-form">
        <label className="dk-redit-f">
          <span>名称</span>
          <div className="dk-field"><input data-autofocus value={name} onChange={(e) => { setName(e.target.value); setError(''); }} onKeyDown={onEnter} placeholder="例如：Pixiv 作品 ID" /></div>
        </label>
        <label className="dk-redit-f">
          <span>置信度<small>0–1，低于 {LOW_CONFIDENCE} 时整理保持原位</small></span>
          <div className="dk-field"><input type="number" min={0} max={1} step={0.05} inputMode="decimal" value={confidence} onChange={(e) => { setConfidence(e.target.value); setError(''); }} onKeyDown={onEnter} /></div>
        </label>
        <label className="dk-redit-f wide">
          <span>模式（正则表达式）</span>
          <div className={`dk-field mono ${regexError ? 'err' : ''}`}><input value={pattern} spellCheck={false} aria-invalid={regexError ? true : undefined} onChange={(e) => { setPattern(e.target.value); setError(''); }} onKeyDown={onEnter} placeholder={'^(\\d{1,4})_(\\d{5,})_p(\\d+)$'} /></div>
        </label>
        <label className="dk-redit-f wide">
          <span>目标目录</span>
          <div className="dk-field mono"><input value={target} spellCheck={false} onChange={(e) => { setTarget(e.target.value); setError(''); }} onKeyDown={onEnter} placeholder="$2" /></div>
        </label>
        <label className="dk-redit-f wide">
          <span>测试文件名</span>
          <div className="dk-field mono"><MagnifyingGlass size={13} aria-hidden="true" /><input value={sample} spellCheck={false} onChange={(e) => setSample(e.target.value)} onKeyDown={onEnter} /></div>
        </label>
        <div className={`dk-redit-preview ${regexError ? 'err' : ''}`} aria-live="polite">
          {regexError ? `正则表达式无效：${regexError}` : preview ? <>→ <code>{preview.virtualPath}</code></> : '→ 不匹配或目标目录为空'}
        </div>
        {error && <div className="dk-hint-t err" role="alert">{error}</div>}
      </div>
      <div className="dk-dlg-f">
        {rule && (
          <button
            type="button"
            className="dk-btn ghost dk-redit-del"
            onClick={() => {
              onDelete(rule.id);
              onClose();
            }}
          >
            删除规则
          </button>
        )}
        <span className="dk-spacer" />
        <button type="button" className="dk-btn ghost" onClick={onClose}>取消</button>
        <button type="button" className="dk-btn primary" onClick={submit}>{rule ? '保存' : '添加'}</button>
      </div>
    </DialogFrame>
  );
}
