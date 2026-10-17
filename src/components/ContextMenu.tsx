import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampMenuPosition, positionSubmenu } from './menuGeometry';

export type ContextMenuPosition = { x: number; y: number };
export type ContextMenuItem =
  | { type: 'separator'; id: string }
  | {
      type?: 'action';
      id: string;
      label: string;
      onSelect?: () => void;
      disabled?: boolean;
      shortcut?: string;
      danger?: boolean;
      swatch?: string;
      submenu?: {
        type: 'swatches';
        items: {
          id: string;
          label: string;
          color: string;
          selected?: boolean;
          onSelect: () => void;
        }[];
      };
    };
export type ContextMenuCloseReason = 'escape' | 'outside' | 'select';
export type ContextMenuProps = {
  position: ContextMenuPosition;
  items: ContextMenuItem[];
  onClose: (reason: ContextMenuCloseReason) => void;
  returnFocusTo: HTMLElement | null;
  label?: string;
};

export function contextMenuPointForElement(
  element: HTMLElement,
): ContextMenuPosition {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

export function isContextMenuKey(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey'>,
): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

export function nextEnabledMenuIndex(
  items: ContextMenuItem[],
  current: number,
  direction: 1 | -1,
): number {
  if (items.length === 0) return -1;
  for (let step = 1; step <= items.length; step++) {
    const index = (current + direction * step + items.length) % items.length;
    const item = items[index];
    if (item.type !== 'separator' && !item.disabled) return index;
  }
  return -1;
}

export default function ContextMenu({
  position: anchor,
  items,
  onClose,
  returnFocusTo,
  label = 'Context menu',
}: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const submenuElement = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const actions = items.filter(
    (item): item is Extract<ContextMenuItem, { label: string }> =>
      item.type !== 'separator',
  );

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setPosition(
        clampMenuPosition(
          anchor.x,
          anchor.y,
          rect.width,
          rect.height,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !element.contains(target) &&
        !submenuElement.current?.contains(target)
      )
        onClose('outside');
    };
    const blur = () => onClose('outside');
    document.addEventListener('pointerdown', outside);
    window.addEventListener('blur', blur);
    const first = element.querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    );
    first?.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('blur', blur);
    };
  }, [anchor.x, anchor.y, onClose]);

  useLayoutEffect(() => {
    if (!openSubmenu) return;
    const update = () => {
      const anchorElement = menu.current?.querySelector<HTMLElement>(
        `[data-menu-id="${CSS.escape(openSubmenu)}"]`,
      );
      const palette = submenuElement.current;
      if (!anchorElement || !palette) return;
      const anchorRect = anchorElement.getBoundingClientRect();
      const paletteRect = palette.getBoundingClientRect();
      const next = positionSubmenu(
        anchorRect,
        { width: paletteRect.width, height: paletteRect.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      palette.style.left = `${next.left}px`;
      palette.style.top = `${next.top}px`;
    };
    update();
    const observer = new ResizeObserver(update);
    if (submenuElement.current) observer.observe(submenuElement.current);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [openSubmenu, items]);

  const focusReturn = () => returnFocusTo?.isConnected && returnFocusTo.focus();
  const activate = (item: Extract<ContextMenuItem, { label: string }>) => {
    if (item.disabled) return;
    onClose('select');
    item.onSelect?.();
  };

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      className="app-popup-surface fixed z-[1000] min-w-36 max-w-[calc(100vw-16px)] overflow-auto p-1 text-sm select-none"
      style={{
        left: position.left,
        top: position.top,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100vh - 16px)',
      }}
      onKeyDown={(event) => {
        const enabled = actions.filter((item) => !item.disabled);
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose('escape');
          focusReturn();
        } else if (event.key === 'Tab') onClose('outside');
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const index = nextEnabledMenuIndex(
            items,
            items.findIndex(
              (item) =>
                item.type !== 'separator' &&
                item.id ===
                  (document.activeElement as HTMLElement)?.dataset.menuId,
            ),
            event.key === 'ArrowDown' ? 1 : -1,
          );
          if (index >= 0)
            menu.current
              ?.querySelector<HTMLElement>(
                `[data-menu-id="${CSS.escape(items[index].id)}"]`,
              )
              ?.focus();
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const item = event.key === 'Home' ? enabled[0] : enabled.at(-1);
          menu.current
            ?.querySelector<HTMLElement>(
              `[data-menu-id="${CSS.escape(item?.id ?? '')}"]`,
            )
            ?.focus();
        } else if (event.key === 'ArrowRight') {
          const item = actions.find(
            (candidate) =>
              candidate.id ===
              (document.activeElement as HTMLElement)?.dataset.menuId,
          );
          if (item?.submenu) {
            event.preventDefault();
            setOpenSubmenu(item.id);
          }
        } else if (event.key === 'ArrowLeft') {
          if (openSubmenu) {
            event.preventDefault();
            setOpenSubmenu(null);
            menu.current
              ?.querySelector<HTMLElement>(
                `[data-menu-id="${CSS.escape(openSubmenu)}"]`,
              )
              ?.focus();
          }
        } else if (event.key === 'Enter' || event.key === ' ') {
          const item = actions.find(
            (candidate) =>
              candidate.id ===
              (document.activeElement as HTMLElement)?.dataset.menuId,
          );
          if (item) {
            event.preventDefault();
            if (item.submenu)
              setOpenSubmenu(openSubmenu === item.id ? null : item.id);
            else activate(item);
          }
        }
      }}
    >
      {items.map((item) =>
        item.type === 'separator' ? (
          <div
            key={item.id}
            role="separator"
            className="my-1 border-t border-white/10"
          />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            data-menu-id={item.id}
            aria-disabled={item.disabled || undefined}
            tabIndex={-1}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? openSubmenu === item.id : undefined}
            onMouseEnter={() => {
              if (item.submenu) setOpenSubmenu(item.id);
            }}
            onClick={() =>
              item.submenu
                ? setOpenSubmenu(openSubmenu === item.id ? null : item.id)
                : activate(item)
            }
            className={`app-popup-row flex w-full items-center justify-between gap-6 px-2 py-1.5 text-left ${item.disabled ? 'cursor-default opacity-45' : ''} ${item.danger ? 'text-red-300' : ''}`}
          >
            <span className="flex items-center gap-2">
              {item.swatch && (
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: item.swatch }}
                />
              )}
              {item.label}
            </span>
            {item.submenu ? (
              <span aria-hidden="true" className="text-white/50">
                ›
              </span>
            ) : (
              item.shortcut && (
                <span className="text-xs text-white/50">{item.shortcut}</span>
              )
            )}
          </button>
        ),
      )}
      {items
        .filter(
          (item) =>
            item.type !== 'separator' &&
            item.submenu &&
            item.id === openSubmenu,
        )
        .map(
          (item) =>
            item.type !== 'separator' &&
            item.submenu &&
            createPortal(
              <div
                ref={submenuElement}
                role="menu"
                aria-label={`${item.label} colors`}
                key={`submenu-${item.id}`}
                onKeyDown={(event) => {
                  const buttons = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      'button',
                    ),
                  );
                  const index = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  if (event.key === 'Escape' || event.key === 'ArrowLeft') {
                    event.preventDefault();
                    setOpenSubmenu(null);
                    menu.current
                      ?.querySelector<HTMLElement>(
                        `[data-menu-id="${CSS.escape(item.id)}"]`,
                      )
                      ?.focus();
                  } else if (
                    [
                      'ArrowLeft',
                      'ArrowRight',
                      'ArrowUp',
                      'ArrowDown',
                    ].includes(event.key)
                  ) {
                    event.preventDefault();
                    const delta =
                      event.key === 'ArrowLeft'
                        ? -1
                        : event.key === 'ArrowRight'
                          ? 1
                          : event.key === 'ArrowUp'
                            ? -4
                            : 4;
                    buttons[
                      (index + delta + buttons.length) % buttons.length
                    ]?.focus();
                  }
                }}
                className="app-popup-surface fixed z-[1001] grid grid-cols-4 gap-1.5 p-2"
                style={{
                  left: position.left + 150,
                  top: position.top,
                  maxWidth: 'calc(100vw - 16px)',
                  maxHeight: 'calc(100vh - 16px)',
                  overflow: 'auto',
                }}
              >
                {item.submenu.items.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitem"
                    aria-label={option.label}
                    title={option.label}
                    aria-checked={option.selected || undefined}
                    onClick={() => {
                      onClose('select');
                      option.onSelect();
                    }}
                    className={`h-7 w-7 rounded-full border-2 ${option.selected ? 'border-white ring-1 ring-white/60' : 'border-white/25 hover:border-white/80'}`}
                    style={{ backgroundColor: option.color }}
                  />
                ))}
              </div>,
              document.body,
              `submenu-${item.id}`,
            ),
        )}
    </div>,
    document.body,
  );
}
