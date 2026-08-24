import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

export function SidebarResizeHandle({
  width,
  onResize,
  min = 200,
  max = 480,
}: {
  width: number;
  onResize: (width: number) => void;
  min?: number;
  max?: number;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is not available in some test/embedded environments.
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(max, Math.max(min, drag.startWidth + event.clientX - drag.startX));
    onResize(next);
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore release failures.
    }
  };

  return (
    <div
      className="absolute top-0 right-0 h-full w-1.5 cursor-ew-resize transition-colors hover:bg-primary/40 active:bg-primary/60"
      style={{ touchAction: 'none' }}
      title="拖动调整侧边栏宽度"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    />
  );
}
