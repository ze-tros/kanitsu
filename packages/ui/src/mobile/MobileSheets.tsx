import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MobileIcon } from './mobileIcons';
import { Z_DIALOG, Z_PROGRESS, Z_SHEET, Z_TOAST } from './zindex';

/**
 * 移动端底部动作面板（替代桌面右键菜单）。
 * 从底部滑入，遮罩点击/下滑/返回键关闭。
 */
export interface SheetAction {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function MobileActionSheet({
  title,
  subtitle,
  actions,
  onClose,
}: {
  title?: string;
  subtitle?: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; dy: number } | null>(null);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    // 与 CSS 过渡时长一致
    window.setTimeout(onClose, 180);
  };

  // 面板下滑关闭
  const onHandleTouchStart = (e: React.TouchEvent) => {
    dragRef.current = { startY: e.touches[0].clientY, dy: 0 };
  };
  const onHandleTouchMove = (e: React.TouchEvent) => {
    const d = dragRef.current;
    if (!d) return;
    d.dy = Math.max(0, e.touches[0].clientY - d.startY);
    if (panelRef.current) {
      panelRef.current.style.transform = `translateY(${d.dy}px)`;
      panelRef.current.style.transition = 'none';
    }
  };
  const onHandleTouchEnd = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!panelRef.current) return;
    if (d && d.dy > 90) {
      requestClose();
    } else {
      panelRef.current.style.transition = '';
      panelRef.current.style.transform = '';
    }
  };

  return (
    <div className={`m-sheet-mask fixed inset-0 ${closing ? 'm-closing' : ''}`} style={{ zIndex: Z_SHEET }}>
      <div className="m-overlay-scrim absolute inset-0" onClick={requestClose} />
      <div
        ref={panelRef}
        className="m-sheet-panel absolute left-0 right-0 bottom-0 flex flex-col max-h-[78vh]"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }}
      >
        <div
          className="m-sheet-handle-wrap"
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onTouchEnd={onHandleTouchEnd}
        >
          <span className="m-sheet-handle" />
        </div>
        {(title || subtitle) && (
          <div className="m-sheet-header">
            {title && <strong>{title}</strong>}
            {subtitle && <span>{subtitle}</span>}
          </div>
        )}
        <div className="m-sheet-content">
          {actions.map((action, i) => (
            <button
              key={i}
              className={`m-sheet-action ${action.danger ? 'is-danger' : ''}`}
              disabled={action.disabled}
              onClick={() => {
                if (action.disabled) return;
                requestClose();
                // 面板关闭动画后再执行动作（动作可能打开新层）
                window.setTimeout(() => action.onSelect(), 190);
              }}
            >
              {action.icon && (
                <span className="m-sheet-action-icon">
                  {typeof action.icon === 'string' ? <MobileIcon name={action.icon} className="w-5 h-5" /> : action.icon}
                </span>
              )}
              <span className="flex-1 min-w-0 truncate">{action.label}</span>
            </button>
          ))}
        </div>
        <div className="m-sheet-footer">
          <button className="m-sheet-cancel" onClick={requestClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/** 确认对话框（删除等破坏性操作）。 */
export function MobileConfirmDialog({
  title,
  body,
  confirmLabel = '删除',
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="m-dialog-mask fixed inset-0 flex items-center justify-center p-8" style={{ zIndex: Z_DIALOG }}>
      <div className="m-overlay-scrim absolute inset-0" onClick={onCancel} />
      <div className="m-dialog relative w-full max-w-sm p-5">
        <h3 className="m-dialog-title">{title}</h3>
        <p className="m-dialog-copy">{body}</p>
        <div className="m-dialog-actions">
          <button className="m-button" onClick={onCancel}>
            取消
          </button>
          <button className="m-button is-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 输入对话框（重命名 / 新建文件夹）。 */
export function MobilePromptDialog({
  title,
  label,
  initialValue,
  confirmLabel = '确定',
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initialValue: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 延迟聚焦，等弹窗动画与输入法就绪
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 220);
    return () => window.clearTimeout(t);
  }, []);

  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
  };

  return (
    <div className="m-dialog-mask fixed inset-0 flex items-center justify-center p-8" style={{ zIndex: Z_DIALOG }}>
      <div className="m-overlay-scrim absolute inset-0" onClick={onCancel} />
      <div className="m-dialog relative w-full max-w-sm p-5">
        <h3 className="m-dialog-title">{title}</h3>
        <div className="mt-3">
          <span className="m-dialog-label">{label}</span>
          <input
            ref={inputRef}
            className="m-input mt-1.5"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onCancel();
            }}
          />
        </div>
        <div className="m-dialog-actions">
          <button className="m-button" onClick={onCancel}>
            取消
          </button>
          <button
            className="m-button is-primary"
            disabled={!value.trim()}
            onClick={submit}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 底部 Toast（自动消失由调用方控制）。 */
export function MobileToast({ text, kind }: { text: string; kind: 'info' | 'success' | 'error' }) {
  const cls = kind === 'error' ? 'is-error' : kind === 'success' ? 'is-success' : '';
  return (
    <div
      className="m-toast fixed left-1/2 -translate-x-1/2 pointer-events-none max-w-[86vw]"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 88px)', zIndex: Z_TOAST }}
    >
      <div className={`m-toast-card ${cls}`}>{text}</div>
    </div>
  );
}

/** 底部进度卡片（导入 / 导出 / 整理进行中）。 */
export function MobileProgressCard({
  title,
  detail,
  done,
  total,
  onCancel,
}: {
  title: string;
  detail?: string;
  done?: number;
  total?: number;
  onCancel?: () => void;
}) {
  const hasProgress = typeof done === 'number' && typeof total === 'number' && total > 0;
  const progressPct = hasProgress ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
  return (
    <div
      className="fixed left-3 right-3"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)', zIndex: Z_PROGRESS }}
    >
      <div className="m-progress-card">
        <div className="flex items-center gap-3">
          <span className="m-progress-spinner" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <div className="m-progress-title">{title}</div>
            {detail && <div className="m-progress-detail truncate mt-0.5">{detail}</div>}
          </div>
          {hasProgress && (
            <span className="m-progress-count shrink-0 tabular-nums">
              {done}/{total}
            </span>
          )}
          {onCancel && (
            <button
              type="button"
              className="m-button is-ghost is-danger shrink-0"
              onClick={onCancel}
              aria-label="取消"
            >
              取消
            </button>
          )}
        </div>
        {hasProgress && (
          <div className="m-progress-track"><span style={{ width: `${progressPct}%` }} /></div>
        )}
      </div>
    </div>
  );
}
