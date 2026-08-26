import { useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
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
/** 入场动画（仅挂载时播放一次）：淡入 + 8px 上移，弹簧缓动。 */
const ENTRANCE_SPRING = { type: 'spring', stiffness: 320, damping: 28, mass: 0.6 } as const;
type SpringOptions = { type: 'spring'; stiffness: number; damping: number; mass: number };

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

  // 入场动画：只在“非滚动中”挂载时播放（快速滚动/拖动期间 .sk-scrolling
  // 存在则跳过，滚动过卡得更清楚）。useLayoutEffect 在首帧绘制前把卡片置为
  // 透明+上移，杜绝“先完整出现一帧再淡入”的闪烁；跳过或中断时一律复位内联
  // 样式，绝不把透明度卡死在 0（否则卡片会“变白”）。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const skipEntrance = (): void => {
      // 无论因何种原因跳过：保证元素立即可见。
      el.style.opacity = '';
      el.style.transform = '';
    };
    if (el.closest('.sk-scrolling')) {
      skipEntrance(); // 快速滚动/拖动中：瞬时出现
      return;
    }
    if (prefersReducedMotion()) {
      skipEntrance();
      return;
    }
    // 显式起点 keyframes，避免依赖浏览器对既有 transform 的解析。
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    lastControls.current?.stop();
    lastControls.current = animate(
      el,
      { opacity: [0, 1], y: [8, 0] },
      ENTRANCE_SPRING as SpringOptions,
    );
    return () => {
      lastControls.current?.stop();
      // StrictMode 双挂载/中途卸载：复位内联样式，避免透明度冻结在 0。
      el.style.opacity = '';
      el.style.transform = '';
    };
  }, []);

  const to = (
    scale: number,
    easing: { type: 'spring'; stiffness: number; damping: number; mass: number } = SCALE_RESET,
  ): void => {
    const el = ref.current;
    if (!el) return;
    lastControls.current?.stop();
    // 入场动画可能正处于中途（opacity 0→1）；悬停/按压如果直接接管，透明
    // 度会冻结在半途——卡片看起来“消失”。因此这里一律先复位为完全可见，
    // transform 交给随后的 scale 动画。
    el.style.opacity = '';
    el.style.transform = '';
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
