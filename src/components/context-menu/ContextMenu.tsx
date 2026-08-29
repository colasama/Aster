import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ContextMenuItem } from "./context-menu-model";
import { positionContextMenu } from "./positioning";

interface ContextMenuProps {
  ariaLabel: string;
  items: readonly ContextMenuItem[];
  onClose: () => void;
  open: boolean;
  x: number;
  y: number;
}

interface MenuSurfaceProps {
  ariaLabel: string;
  autoFocus?: boolean;
  items: readonly ContextMenuItem[];
  onBack?: () => void;
  onClose: () => void;
  placement: "root" | "submenu";
  x: number;
  y: number;
  anchorWidth?: number;
}

const TYPEAHEAD_RESET_MS = 650;

export function ContextMenu({ ariaLabel, items, onClose, open, x, y }: ContextMenuProps) {
  const restoreFocusRef = useRef<HTMLElement | null | undefined>(undefined);
  if (open && restoreFocusRef.current === undefined)
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    if (open || restoreFocusRef.current === undefined) return;
    restoreCapturedFocus(restoreFocusRef);
  }, [open]);
  useEffect(() => () => restoreCapturedFocus(restoreFocusRef), []);
  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: globalThis.PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".context-menu-surface")) onClose();
    };
    const closeOnWindowChange = () => onClose();
    document.addEventListener("pointerdown", closeOnPointer, true);
    window.addEventListener("blur", closeOnWindowChange);
    window.addEventListener("resize", closeOnWindowChange);
    window.addEventListener("scroll", closeOnWindowChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer, true);
      window.removeEventListener("blur", closeOnWindowChange);
      window.removeEventListener("resize", closeOnWindowChange);
      window.removeEventListener("scroll", closeOnWindowChange, true);
    };
  }, [onClose, open]);
  if (!open || items.length === 0) return null;
  return createPortal(
    <div className="context-menu-layer">
      <MenuSurface
        ariaLabel={ariaLabel}
        autoFocus
        items={items}
        onClose={onClose}
        placement="root"
        x={x}
        y={y}
      />
    </div>,
    document.body,
  );
}

function restoreCapturedFocus(ref: { current: HTMLElement | null | undefined }): void {
  const target = ref.current;
  ref.current = undefined;
  queueMicrotask(() => {
    if (target?.isConnected) target.focus({ preventScroll: true });
  });
}

function MenuSurface({
  ariaLabel,
  autoFocus = false,
  items,
  onBack,
  onClose,
  placement,
  x,
  y,
  anchorWidth,
}: MenuSurfaceProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeahead = useRef("");
  const typeaheadTimer = useRef<number | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(() => firstEnabled(items));
  const [openSubmenu, setOpenSubmenu] = useState<string>();
  const [style, setStyle] = useState<CSSProperties>({ left: x, top: y, visibility: "hidden" });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const position = positionContextMenu({
      anchorX: x,
      anchorY: y,
      anchorWidth,
      menuWidth: bounds.width,
      menuHeight: bounds.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      placement,
    });
    setStyle({ left: position.left, top: position.top, visibility: "visible" });
  }, [anchorWidth, placement, x, y]);

  useLayoutEffect(() => {
    if (!autoFocus) return;
    const index = activeIndex >= 0 ? activeIndex : firstEnabled(items);
    itemRefs.current[index]?.focus({ preventScroll: true });
  }, [activeIndex, autoFocus, items]);

  useEffect(
    () => () => {
      if (typeaheadTimer.current !== undefined) window.clearTimeout(typeaheadTimer.current);
    },
    [],
  );

  const moveFocus = (direction: 1 | -1) => {
    const next = nextEnabled(items, activeIndex, direction);
    if (next < 0) return;
    setActiveIndex(next);
    setOpenSubmenu(undefined);
    itemRefs.current[next]?.focus({ preventScroll: true });
  };
  const activate = (item: ContextMenuItem) => {
    if (item.kind === "separator" || item.disabled) return;
    if (item.kind === "submenu") {
      setOpenSubmenu(item.id);
      return;
    }
    item.onSelect();
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? firstEnabled(items) : lastEnabled(items);
      setActiveIndex(next);
      setOpenSubmenu(undefined);
      itemRefs.current[next]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowLeft" && onBack) {
      event.preventDefault();
      onBack();
      return;
    }
    const item = items[activeIndex];
    if (event.key === "ArrowRight" && item?.kind === "submenu" && !item.disabled) {
      event.preventDefault();
      setOpenSubmenu(item.id);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && item) {
      event.preventDefault();
      activate(item);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    typeahead.current += event.key.toLocaleLowerCase();
    if (typeaheadTimer.current !== undefined) window.clearTimeout(typeaheadTimer.current);
    typeaheadTimer.current = window.setTimeout(() => (typeahead.current = ""), TYPEAHEAD_RESET_MS);
    const match = findTypeahead(items, typeahead.current, activeIndex);
    if (match >= 0) {
      setActiveIndex(match);
      setOpenSubmenu(undefined);
      itemRefs.current[match]?.focus({ preventScroll: true });
    }
  };

  return (
    <div
      aria-label={ariaLabel}
      className="context-menu-surface"
      onKeyDown={onKeyDown}
      ref={menuRef}
      role="menu"
      style={style}
    >
      {items.map((item, index) => {
        if (item.kind === "separator")
          return <hr className="context-menu-separator" key={item.id} />;
        const submenuOpen = item.kind === "submenu" && openSubmenu === item.id;
        const role =
          item.kind === "checkbox"
            ? "menuitemcheckbox"
            : item.kind === "radio"
              ? "menuitemradio"
              : "menuitem";
        return (
          <div className="context-menu-entry" key={item.id}>
            {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the runtime role is narrowed from the discriminated menu item kind. */}
            <button
              aria-checked={
                item.kind === "checkbox" || item.kind === "radio" ? item.checked : undefined
              }
              aria-disabled={item.disabled || undefined}
              aria-description={item.disabled ? item.disabledReason : undefined}
              aria-expanded={item.kind === "submenu" ? submenuOpen : undefined}
              aria-haspopup={item.kind === "submenu" ? "menu" : undefined}
              className={`${item.destructive ? "destructive" : ""} ${submenuOpen ? "submenu-open" : ""}`}
              disabled={item.disabled}
              onClick={() => activate(item)}
              onFocus={() => setActiveIndex(index)}
              onPointerEnter={(event: PointerEvent<HTMLButtonElement>) => {
                setActiveIndex(index);
                event.currentTarget.focus({ preventScroll: true });
                setOpenSubmenu(item.kind === "submenu" && !item.disabled ? item.id : undefined);
              }}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              role={role}
              tabIndex={index === activeIndex ? 0 : -1}
              title={item.disabled ? item.disabledReason : undefined}
              type="button"
            >
              <span aria-hidden="true" className="context-menu-mark">
                {item.kind === "checkbox" && item.checked
                  ? "✓"
                  : item.kind === "radio" && item.checked
                    ? "●"
                    : item.icon}
              </span>
              <span className="context-menu-label">{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
              {item.kind === "submenu" && (
                <span aria-hidden="true" className="context-menu-arrow">
                  ›
                </span>
              )}
            </button>
            {submenuOpen && (
              <Submenu
                anchor={itemRefs.current[index]}
                ariaLabel={item.label}
                items={item.items}
                onBack={() => {
                  setOpenSubmenu(undefined);
                  itemRefs.current[index]?.focus({ preventScroll: true });
                }}
                onClose={onClose}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Submenu({
  anchor,
  ariaLabel,
  items,
  onBack,
  onClose,
}: {
  anchor: HTMLButtonElement | null;
  ariaLabel: string;
  items: readonly ContextMenuItem[];
  onBack: () => void;
  onClose: () => void;
}) {
  if (!anchor) return null;
  const bounds = anchor.getBoundingClientRect();
  return (
    <MenuSurface
      anchorWidth={bounds.width}
      ariaLabel={ariaLabel}
      autoFocus
      items={items}
      onBack={onBack}
      onClose={onClose}
      placement="submenu"
      x={bounds.left}
      y={bounds.top}
    />
  );
}

function firstEnabled(items: readonly ContextMenuItem[]): number {
  return items.findIndex((item) => item.kind !== "separator" && !item.disabled);
}

function lastEnabled(items: readonly ContextMenuItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "separator" && !item?.disabled) return index;
  }
  return -1;
}

function nextEnabled(
  items: readonly ContextMenuItem[],
  current: number,
  direction: 1 | -1,
): number {
  if (items.length === 0) return -1;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (current + direction * offset + items.length) % items.length;
    const item = items[index];
    if (item?.kind !== "separator" && !item?.disabled) return index;
  }
  return -1;
}

function findTypeahead(items: readonly ContextMenuItem[], query: string, current: number): number {
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (current + offset + items.length) % items.length;
    const item = items[index];
    if (
      item?.kind !== "separator" &&
      !item?.disabled &&
      item?.label.toLocaleLowerCase().startsWith(query)
    )
      return index;
  }
  return -1;
}
