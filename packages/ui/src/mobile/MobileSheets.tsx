import { useEffect, useRef, useState, type ReactNode } from 'react';

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
    <div className={`m-sheet-mask fixed inset-0 z-[140] ${closing ? 'm-closing' : ''}`}>
      <div className="absolute inset-0 bg-black/45" onClick={requestClose} />
      <div
        ref={panelRef}
        className="m-sheet-panel absolute left-0 right-0 bottom-0 bg-base-100 rounded-t-3xl shadow-2xl flex flex-col max-h-[78vh]"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }}
      >
        <div
          className="pt-2 pb-1 flex justify-center touch-none"
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onTouchEnd={onHandleTouchEnd}
        >
          <span className="w-9 h-1 rounded-full bg-base-content/25" />
        </div>
        {(title || subtitle) && (
          <div className="px-5 pt-1 pb-2 border-b border-base-300/60 min-w-0">
            {title && <div className="text-base font-semibold truncate">{title}</div>}
            {subtitle && <div className="text-xs opacity-60 truncate mt-0.5">{subtitle}</div>}
          </div>
        )}
        <div className="overflow-y-auto overscroll-contain py-1.5">
          {actions.map((action, i) => (
            <button
              key={i}
              className={`w-full flex items-center gap-3.5 px-5 py-3.5 text-left text-[15px] active:bg-base-300/50 transition-colors ${
                action.danger ? 'text-error' : ''
              } ${action.disabled ? 'opacity-40' : ''}`}
              disabled={action.disabled}
              onClick={() => {
                if (action.disabled) return;
                requestClose();
                // 面板关闭动画后再执行动作（动作可能打开新层）
                window.setTimeout(() => action.onSelect(), 190);
              }}
            >
              {action.icon && <span className="w-6 text-center text-lg opacity-80 shrink-0">{action.icon}</span>}
              <span className="flex-1 min-w-0 truncate">{action.label}</span>
            </button>
          ))}
        </div>
        <div className="px-3 pt-1">
          <button className="w-full py-3 rounded-2xl bg-base-200 text-[15px] font-medium active:bg-base-300" onClick={requestClose}>
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
    <div className="m-dialog-mask fixed inset-0 z-[150] flex items-center justify-center p-8">
      <div className="absolute inset-0 bg-black/45" onClick={onCancel} />
      <div className="m-dialog relative bg-base-100 rounded-3xl shadow-2xl w-full max-w-sm p-5">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm opacity-75 mt-2 leading-relaxed">{body}</p>
        <div className="flex gap-2.5 mt-5">
          <button className="flex-1 py-2.5 rounded-xl bg-base-200 text-[15px] active:bg-base-300" onClick={onCancel}>
            取消
          </button>
          <button className="flex-1 py-2.5 rounded-xl bg-error text-error-content text-[15px] font-medium active:opacity-90" onClick={onConfirm}>
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
    <div className="m-dialog-mask fixed inset-0 z-[150] flex items-center justify-center p-8">
      <div className="absolute inset-0 bg-black/45" onClick={onCancel} />
      <div className="m-dialog relative bg-base-100 rounded-3xl shadow-2xl w-full max-w-sm p-5">
        <h3 className="text-base font-semibold">{title}</h3>
        <div className="mt-3">
          <span className="text-xs opacity-60">{label}</span>
          <input
            ref={inputRef}
            className="input input-bordered w-full mt-1.5 text-[15px] rounded-xl"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onCancel();
            }}
          />
        </div>
        <div className="flex gap-2.5 mt-5">
          <button className="flex-1 py-2.5 rounded-xl bg-base-200 text-[15px] active:bg-base-300" onClick={onCancel}>
            取消
          </button>
          <button
            className="flex-1 py-2.5 rounded-xl bg-primary text-primary-content text-[15px] font-medium active:opacity-90 disabled:opacity-40"
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
  const cls = kind === 'error' ? 'bg-error text-error-content' : kind === 'success' ? 'bg-success text-success-content' : 'bg-neutral text-neutral-content';
  return (
    <div
      className="m-toast fixed left-1/2 -translate-x-1/2 z-[170] pointer-events-none max-w-[86vw]"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 88px)' }}
    >
      <div className={`${cls} rounded-2xl px-4 py-2.5 text-sm shadow-xl leading-snug`}>{text}</div>
    </div>
  );
}

/** 底部进度卡片（导入 / 导出 / 整理进行中）。 */
export function MobileProgressCard({
  title,
  detail,
  done,
  total,
}: {
  title: string;
  detail?: string;
  done?: number;
  total?: number;
}) {
  const hasProgress = typeof done === 'number' && typeof total === 'number' && total > 0;
  return (
    <div
      className="fixed left-3 right-3 z-[160]"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}
    >
      <div className="bg-base-100 border border-base-300 rounded-2xl shadow-xl p-4">
        <div className="flex items-center gap-3">
          <span className="loading loading-spinner loading-sm text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{title}</div>
            {detail && <div className="text-xs opacity-60 truncate mt-0.5">{detail}</div>}
          </div>
          {hasProgress && (
            <span className="text-xs opacity-70 shrink-0 tabular-nums">
              {done}/{total}
            </span>
          )}
        </div>
        {hasProgress && (
          <progress className="progress progress-primary w-full mt-2.5 h-1.5" value={done} max={total} />
        )}
      </div>
    </div>
  );
}
