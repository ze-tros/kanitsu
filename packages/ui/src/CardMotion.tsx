import { useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { animate } from 'motion/mini';

/**
 * 基于 motion（motion-one 并入后的统一包）的卡片微交互实验件（experiment/motion-one）。
 *
 * 用 spring 物理动画替代 CSS scale 反馈：
 *   hover  → scale 1.03（微微浮起）
 *   press  → scale 0.97（按下回弹）
 *   离开/松开 → 回到 1
 * 仅动 transform（合成器属性）。尊重 prefers-reduced-motion：回退瞬时缩放。
 */
const SCALE_UP = { type: 'spring', stiffness: 480, damping: 32, mass: 0.5 } as const;
const SCALE_DOWN = { type: 'spring', stiffness: 700, damping: 26, mass: 0.4 } as const;
const SCALE_RESET = { type: 'spring', stiffness: 400, damping: 34, mass: 0.6 } as const;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function CardMotion({
  children,
  className,
  onClick,
  onContextMenu,
}: {
  children: ReactNode;
  className?: string;
  onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const lastControls = useRef<ReturnType<typeof animate> | null>(null);

  const to = (
    scale: number,
    easing: { type: 'spring'; stiffness: number; damping: number; mass: number } = SCALE_RESET,
  ): void => {
    const el = ref.current;
    if (!el) return;
    lastControls.current?.stop();
    if (prefersReducedMotion()) {
      el.style.transform = scale === 1 ? '' : `scale(${scale})`;
      return;
    }
    lastControls.current = animate(el, { scale }, easing);
  };

  return (
    <div
      ref={ref}
      className={className}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerEnter={() => to(1.03, SCALE_UP)}
      onPointerLeave={() => to(1, SCALE_RESET)}
      onPointerDown={() => to(0.97, SCALE_DOWN)}
      onPointerUp={() => to(1.03, SCALE_UP)}
      onPointerCancel={() => to(1, SCALE_RESET)}
    >
      {children}
    </div>
  );
}
