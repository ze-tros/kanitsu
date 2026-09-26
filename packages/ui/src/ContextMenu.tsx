import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from '@phosphor-icons/react';

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a separator line immediately above this item. */
  separator?: boolean;
  /** Toggle-state marker: renders a trailing check and switches the item to a checkbox role. */
  checked?: boolean;
  onSelect: () => void;
}

export interface ContextMenuModel {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const EDGE_MARGIN = 8;

interface MenuPlacement {
  left: number;
  top: number;
  originX: 'left' | 'right';
  originY: 'top' | 'bottom';
}

export function ContextMenu({
  menu,
  onClose,
  container,
}: {
  menu: ContextMenuModel | null;
  onClose: () => void;
  /** Portal target inside the themed app root so the menu inherits studio tokens. */
  container?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement>({
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
  });

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
    // The entry animation should scale out of the corner nearest the cursor.
    const originX: MenuPlacement['originX'] = menu.x > left + rect.width / 2 ? 'right' : 'left';
    const originY: MenuPlacement['originY'] = menu.y > top + rect.height / 2 ? 'bottom' : 'top';
    setPlacement({ left, top, originX, originY });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstEnabled = menu.items.findIndex((item) => !item.disabled);
    const focusTimer = window.setTimeout(() => itemRefs.current[firstEnabled]?.focus(), 0);
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
      window.clearTimeout(focusTimer);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onClose);
      const previousFocus = previousFocusRef.current;
      window.setTimeout(() => {
        const active = document.activeElement;
        if (previousFocus && (!active || active === document.body || !active.isConnected)) {
          previousFocus.focus({ preventScroll: true });
        }
      }, 0);
      previousFocusRef.current = null;
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const portalTarget = container && container.isConnected ? container : document.body;

  return createPortal(
    <div
      ref={ref}
      className="dk-menu"
      style={{
        left: placement.left,
        top: placement.top,
        transformOrigin: `${placement.originX} ${placement.originY}`,
      }}
      role="menu"
      aria-orientation="vertical"
      onKeyDown={(event) => {
        const enabled = menu.items
          .map((item, index) => (item.disabled ? -1 : index))
          .filter((index) => index >= 0);
        if (enabled.length === 0) return;
        const current = enabled.indexOf(Number((document.activeElement as HTMLElement)?.dataset.menuIndex ?? -1));
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const offset = event.key === 'ArrowDown' ? 1 : -1;
          const next = enabled[(current + offset + enabled.length) % enabled.length] ?? enabled[0]!;
          itemRefs.current[next]?.focus();
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          itemRefs.current[event.key === 'Home' ? enabled[0]! : enabled[enabled.length - 1]!]?.focus();
        } else if (event.key === 'Tab') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {menu.items.map((item, index) => (
        <Fragment key={`${item.label}-${index}`}>
          {item.separator && <div className="dk-menu-sep" role="separator" />}
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked === undefined ? undefined : Boolean(item.checked)}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            data-menu-index={index}
            tabIndex={item.disabled ? -1 : index === menu.items.findIndex((entry) => !entry.disabled) ? 0 : -1}
            className={`dk-menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            {item.icon != null && <span className="dk-menu-icon">{item.icon}</span>}
            <span className="dk-menu-label">{item.label}</span>
            {item.checked != null && (
              <span className="dk-menu-check" aria-hidden="true">
                {item.checked && <Check size={13} weight="bold" />}
              </span>
            )}
          </button>
        </Fragment>
      ))}
    </div>,
    portalTarget,
  );
}
