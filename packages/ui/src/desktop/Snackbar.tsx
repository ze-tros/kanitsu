import { CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react';

export interface SnackAction {
  label: string;
  onPress: () => void;
}

export interface SnackMessage {
  /** 自增 id：相同文案连续出现时也能重置自动消失计时。 */
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
  actions?: SnackAction[];
}

/** 左下角的操作结果提示；带撤销 / 打开等动作时停留更久。 */
export function Snackbar({ snack, left, onClose }: { snack: SnackMessage | null; left: number; onClose: () => void }) {
  if (!snack) return null;
  const Icon = snack.kind === 'error' ? WarningCircle : snack.kind === 'success' ? CheckCircle : Info;
  return (
    <div
      key={snack.id}
      className={`dk-snack ${snack.kind}`}
      style={{ left }}
      role={snack.kind === 'error' ? 'alert' : 'status'}
      aria-live={snack.kind === 'error' ? 'assertive' : 'polite'}
    >
      <Icon size={18} weight="fill" />
      <span className="dk-snack-text">{snack.text}</span>
      {snack.actions?.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => {
            action.onPress();
            onClose();
          }}
        >
          {action.label}
        </button>
      ))}
      <button type="button" className="dk-snack-close" aria-label="关闭提示" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
