import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { MobileIcon, type MobileIconName } from './mobileIcons';
import { Z_DIALOG, Z_SHEET, Z_TOAST } from './zindex';

const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function trapFocus(event: ReactKeyboardEvent<HTMLElement>, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => element.offsetParent !== null);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * 移动端底部动作面板（替代桌面右键菜单）。
 * 从底部滑入，遮罩点击/下滑/返回键关闭。
 */
export interface SheetAction {
  label: string;
  icon?: MobileIconName;
  danger?: boolean;
  disabled?: boolean;
  /** 选中态标记（单选选择器用），渲染为右侧勾选。 */
  checked?: boolean;
  onSelect: () => void;
}

export function MobileActionSheet({
  title,
  subtitle,
  media,
  quickActions = [],
  actions,
  onClose,
}: {
  title?: string;
  subtitle?: string;
  /** 标题左侧的缩略图（图片/图包封面）。 */
  media?: ReactNode;
  /** 顶部四宫格快捷动作（常用操作），其余动作以列表呈现。 */
  quickActions?: SheetAction[];
  actions: SheetAction[];
  onClose: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{ startY: number; dy: number } | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const titleId = useId();
  const subtitleId = useId();

  useEffect(() => {
    const firstAction = panelRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])');
    firstAction?.focus();
    return () => {
      restoreFocusRef.current?.focus({ preventScroll: true });
    };
  }, []);

  const requestClose = (afterClose?: () => void) => {
    if (closing) return;
    setClosing(true);
    // 与 CSS 过渡时长一致；动作在面板真正卸载前执行，避免新 overlay 与旧层竞态。
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
      afterClose?.();
    }, 180);
  };

  useEffect(() => () => {
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
  }, []);

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
      <div className="m-overlay-scrim absolute inset-0" onClick={() => requestClose()} />
      <div
        ref={panelRef}
        className="m-sheet-panel absolute left-0 right-0 bottom-0 flex flex-col max-h-[78vh]"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }}
        role="dialog"
        aria-modal="true"
        aria-label={title ? undefined : '操作'}
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') requestClose();
          trapFocus(e, panelRef.current);
        }}
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
          <div className={`m-sheet-header ${media ? 'has-media' : ''}`}>
            {media && <span className="m-sheet-media" aria-hidden="true">{media}</span>}
            <span className="m-sheet-heading">
              {title && <strong id={titleId}>{title}</strong>}
              {subtitle && <span id={subtitleId}>{subtitle}</span>}
            </span>
          </div>
        )}
        {quickActions.length > 0 && (
          <div className="m-sheet-quick" role="group" aria-label="常用操作">
            {quickActions.map((action, i) => (
              <button
                key={i}
                className={action.danger ? 'is-danger' : ''}
                disabled={action.disabled}
                onClick={() => {
                  if (action.disabled) return;
                  requestClose(action.onSelect);
                }}
              >
                {action.icon && <MobileIcon name={action.icon} className="w-[22px] h-[22px]" />}
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="m-sheet-content">
          {actions.map((action, i) => (
            <button
              key={i}
              className={`m-sheet-action ${action.danger ? 'is-danger' : ''}`}
              disabled={action.disabled}
              aria-pressed={action.checked === undefined ? undefined : action.checked}
              onClick={() => {
                if (action.disabled) return;
                requestClose(action.onSelect);
              }}
            >
              {action.icon && (
                <span className="m-sheet-action-icon">
                  <MobileIcon name={action.icon} className="w-5 h-5" />
                </span>
              )}
              <span className="flex-1 min-w-0 truncate">{action.label}</span>
              {action.checked && (
                <span className="m-sheet-action-check" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="m-sheet-footer">
          <button className="m-sheet-cancel" onClick={() => requestClose()}>
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
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    return () => {
      restoreFocusRef.current?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className="m-dialog-mask fixed inset-0 flex items-center justify-center p-8" style={{ zIndex: Z_DIALOG }}>
      <div className="m-overlay-scrim absolute inset-0" onClick={onCancel} />
      <div
        ref={dialogRef}
        className="m-dialog relative w-full max-w-sm p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          trapFocus(e, dialogRef.current);
        }}
      >
        <h3 id={titleId} className="m-dialog-title">{title}</h3>
        <p id={bodyId} className="m-dialog-copy">{body}</p>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const titleId = useId();
  const labelId = useId();

  useEffect(() => {
    // 延迟聚焦，等弹窗动画与输入法就绪
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 220);
    return () => {
      window.clearTimeout(t);
      restoreFocusRef.current?.focus({ preventScroll: true });
    };
  }, []);

  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
  };

  return (
    <div className="m-dialog-mask fixed inset-0 flex items-center justify-center p-8" style={{ zIndex: Z_DIALOG }}>
      <div className="m-overlay-scrim absolute inset-0" onClick={onCancel} />
      <div
        ref={dialogRef}
        className="m-dialog relative w-full max-w-sm p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          trapFocus(e, dialogRef.current);
        }}
      >
        <h3 id={titleId} className="m-dialog-title">{title}</h3>
        <div className="mt-3">
          <label htmlFor={labelId} className="m-dialog-label">{label}</label>
          <input
            ref={inputRef}
            id={labelId}
            className="m-input mt-1.5"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // isComposing：中文输入法回车上屏候选词时不触发提交。
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
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

export interface ToastAction {
  label: string;
  onPress: () => void;
}

/** 底部 Snackbar（自动消失由调用方控制）。带动作时可点按（如「撤销」「打开」）。 */
export function MobileToast({
  text,
  kind,
  action,
  onDismiss,
  lifted = false,
}: {
  text: string;
  kind: 'info' | 'success' | 'error';
  action?: ToastAction;
  onDismiss?: () => void;
  /** 底部有浮动操作栏/FAB 时上移，避免遮挡。 */
  lifted?: boolean;
}) {
  const cls = kind === 'error' ? 'is-error' : kind === 'success' ? 'is-success' : '';
  return (
    <div
      className={`m-toast fixed left-3 right-3 ${action ? '' : 'pointer-events-none'}`}
      style={{ bottom: `calc(env(safe-area-inset-bottom, 0px) + ${lifted ? 96 : 20}px)`, zIndex: Z_TOAST }}
      role="status"
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className={`m-toast-card ${cls}`}>
        <span className="m-toast-text">{text}</span>
        {action && (
          <button
            className="m-toast-action"
            onClick={() => {
              onDismiss?.();
              action.onPress();
            }}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 通用底部面板：遮罩点击 / 拖动把手下滑 / Esc 关闭，关闭先播放滑出动画再回调。
 * children 可为渲染函数以拿到带动画的 close（选项点选后需要收起面板时使用）。
 */
export function MobileBottomSheet({
  title,
  subtitle,
  headerAction,
  children,
  onClose,
  className = '',
}: {
  title: string;
  subtitle?: string;
  headerAction?: ReactNode;
  children: ReactNode | ((close: (after?: () => void) => void) => ReactNode);
  onClose: () => void;
  className?: string;
}) {
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{ startY: number; dy: number } | null>(null);
  const titleId = useId();
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
      restoreFocusRef.current?.focus({ preventScroll: true });
    };
  }, []);

  const requestClose = (after?: () => void) => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
      after?.();
    }, 180);
  };

  const onDragStart = (e: React.TouchEvent) => {
    dragRef.current = { startY: e.touches[0].clientY, dy: 0 };
  };
  const onDragMove = (e: React.TouchEvent) => {
    const d = dragRef.current;
    if (!d || !panelRef.current) return;
    d.dy = Math.max(0, e.touches[0].clientY - d.startY);
    panelRef.current.style.transition = 'none';
    panelRef.current.style.transform = `translateY(${d.dy}px)`;
  };
  const onDragEnd = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!panelRef.current) return;
    if (d && d.dy > 90) requestClose();
    else {
      panelRef.current.style.transition = '';
      panelRef.current.style.transform = '';
    }
  };

  return (
    <div className={`m-sheet-mask fixed inset-0 ${closing ? 'm-closing' : ''}`} style={{ zIndex: Z_SHEET }}>
      <div className="m-overlay-scrim absolute inset-0" onClick={() => requestClose()} />
      <div
        ref={panelRef}
        className={`m-sheet-panel absolute left-0 right-0 bottom-0 flex flex-col max-h-[86vh] ${className}`}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') requestClose();
          trapFocus(e, panelRef.current);
        }}
      >
        <div className="m-sheet-handle-wrap" onTouchStart={onDragStart} onTouchMove={onDragMove} onTouchEnd={onDragEnd}>
          <span className="m-sheet-handle" />
        </div>
        <div className="m-sheet-header has-action" onTouchStart={onDragStart} onTouchMove={onDragMove} onTouchEnd={onDragEnd}>
          <span className="m-sheet-heading">
            <strong id={titleId}>{title}</strong>
            {subtitle && <span>{subtitle}</span>}
          </span>
          {headerAction}
        </div>
        <div className="m-sheet-body">{typeof children === 'function' ? children(requestClose) : children}</div>
      </div>
    </div>
  );
}
