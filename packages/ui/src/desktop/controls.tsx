/**
 * 桌面端通用小控件：分段选择、开关。标题栏工具条、查看器、设置页共用同一份交互，
 * 外观由调用方的类名区分（dk-seg / dk-v-seg；dk-sw）。
 */
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

/** radiogroup 的方向键 / Home / End：切换选中项并把焦点移过去。 */
export function handleRadioNavigation<T extends string>(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  options: readonly T[],
  current: T,
  onChange: (value: T) => void,
): void {
  const currentIndex = Math.max(0, options.indexOf(current));
  let nextIndex: number | null = null;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % options.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + options.length) % options.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = options.length - 1;
  }
  if (nextIndex == null) return;

  // 同时挡住页面级快捷键（网格方向键、查看器翻页）。
  event.preventDefault();
  event.stopPropagation();
  const next = options[nextIndex];
  if (!next) return;
  onChange(next);
  const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  radios?.[nextIndex]?.focus();
}

export interface SegmentOption<T extends string> {
  value: T;
  /** 按钮内容：文字或图标。 */
  content: ReactNode;
  /** 纯图标按钮必须给出，作为 aria-label 与悬停提示。 */
  label?: string;
  title?: string;
}

/** 分段选择（radiogroup，游走 tabindex）。 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className = 'dk-seg',
}: {
  label: string;
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const values = options.map((option) => option.value);
  return (
    <div className={className} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.label}
          title={option.title ?? option.label}
          tabIndex={value === option.value ? 0 : -1}
          className={value === option.value ? 'on' : ''}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleRadioNavigation(event, values, value, onChange)}
        >
          {option.content}
        </button>
      ))}
    </div>
  );
}

/** 开关（role="switch"）。locked：固定开启、只表达状态，不可切换。 */
export function Switch({
  checked,
  onChange,
  label,
  title,
  locked = false,
}: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label: string;
  title?: string;
  locked?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={locked || undefined}
      aria-label={label}
      title={title}
      className={`dk-sw${checked ? ' on' : ''}${locked ? ' locked' : ''}`}
      onClick={() => {
        if (!locked) onChange?.(!checked);
      }}
    />
  );
}
