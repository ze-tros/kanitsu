import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a separator line immediately above this item. */
  separator?: boolean;
  onSelect: () => void;
}

export interface ContextMenuModel {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const EDGE_MARGIN = 8;

export function ContextMenu({
  menu,
  onClose,
}: {
  menu: ContextMenuModel | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!menu) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(
      EDGE_MARGIN,
      Math.min(menu.x, window.innerWidth - rect.width - EDGE_MARGIN),
    );
    const top = Math.max(
      EDGE_MARGIN,
      Math.min(menu.y, window.innerHeight - rect.height - EDGE_MARGIN),
    );
    setPosition({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onWheel = () => onClose();
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={{ left: position.left, top: position.top }}
      role="menu"
      aria-orientation="vertical"
    >
      {menu.items.map((item, index) => (
        <div key={`${item.label}-${index}`} className="contents">
          {item.separator && <div className="context-menu-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`context-menu-item${item.danger ? ' context-menu-item-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            {item.icon != null && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
