import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/react";
import { type MenuId, type MenuItemId, menuDefinitions } from "./topbar-menu";
import { WorkspaceWindowMenu } from "./workspace/WorkspaceWindowMenu";

export function AppMenuBar({
  onAction,
  recentProjects,
  onOpenRecent,
}: {
  onAction: (item: MenuItemId) => void;
  recentProjects: readonly string[];
  onOpenRecent: (path: string) => void;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState<MenuId>();
  const strip = useRef<HTMLDivElement>(null);
  const edge = useRef<"first" | "last">("first");
  const close = (restore = false) => {
    if (restore)
      strip.current
        ?.querySelector<HTMLButtonElement>(`[aria-controls="app-menu-${active}"]`)
        ?.focus();
    setActive(undefined);
  };
  useLayoutEffect(() => {
    if (!active) return;
    const items = strip.current?.querySelectorAll<HTMLButtonElement>(
      `#app-menu-${active} [role^="menuitem"]:not(:disabled)`,
    );
    items?.[edge.current === "first" ? 0 : items.length - 1]?.focus();
  }, [active]);
  useEffect(() => {
    const document = strip.current?.ownerDocument;
    const owner = document?.defaultView;
    if (!active || !document || !owner) return;
    const hasDialog = () => document.querySelector('[role="dialog"][aria-modal="true"]');
    const outside = (event: PointerEvent) => {
      if (!hasDialog() && !strip.current?.contains(event.target as Node)) setActive(undefined);
    };
    const blur = () => {
      if (!hasDialog()) setActive(undefined);
    };
    document.addEventListener("pointerdown", outside, true);
    owner.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      owner.removeEventListener("blur", blur);
    };
  }, [active]);
  const keyboard = (event: KeyboardEvent, menuId: MenuId) => {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      (event.target as HTMLElement).closest('[role="dialog"]')
    )
      return;
    const trigger = strip.current?.querySelector<HTMLButtonElement>(
      `[aria-controls="app-menu-${menuId}"]`,
    );
    const isTrigger = event.target === trigger;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close(true);
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const index = menuDefinitions.findIndex((menu) => menu.id === menuId);
      const next =
        menuDefinitions[
          (index + (event.key === "ArrowRight" ? 1 : -1) + menuDefinitions.length) %
            menuDefinitions.length
        ];
      edge.current = "first";
      if (active) setActive(next.id);
      else
        strip.current
          ?.querySelector<HTMLButtonElement>(`[aria-controls="app-menu-${next.id}"]`)
          ?.focus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (isTrigger && active !== menuId) {
        edge.current = event.key === "ArrowUp" || event.key === "End" ? "last" : "first";
        setActive(menuId);
        return;
      }
      const items = [
        ...(strip.current?.querySelectorAll<HTMLButtonElement>(
          `#app-menu-${menuId} [role^="menuitem"]:not(:disabled)`,
        ) ?? []),
      ];
      const current = items.indexOf(event.target as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : current < 0
              ? event.key === "ArrowUp"
                ? items.length - 1
                : 0
              : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }
  };
  return (
    <div className="menu-strip" ref={strip}>
      {menuDefinitions.map((menu) => (
        <div className="menu-root" key={menu.id}>
          <button
            aria-controls={`app-menu-${menu.id}`}
            aria-expanded={active === menu.id}
            aria-haspopup="menu"
            className={active === menu.id ? "active" : ""}
            onClick={() => {
              edge.current = "first";
              setActive(active === menu.id ? undefined : menu.id);
            }}
            onKeyDown={(event) => keyboard(event, menu.id)}
            onPointerEnter={() => {
              if (active && !strip.current?.ownerDocument.querySelector('[aria-modal="true"]')) {
                edge.current = "first";
                setActive(menu.id);
              }
            }}
            type="button"
          >
            {t(menu.labelKey)}
          </button>
          {active === menu.id && (
            // biome-ignore lint/a11y/noStaticElementInteractions: The Window menu supplies its own menu role inside this keyboard delegation boundary.
            <div
              className="app-menu-popover"
              id={`app-menu-${menu.id}`}
              role={menu.id === "window" ? undefined : "menu"}
              onKeyDown={(event) => keyboard(event, menu.id)}
            >
              {menu.id === "window" ? (
                <WorkspaceWindowMenu onClose={() => close(true)} />
              ) : (
                menu.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      close(true);
                      onAction(item.id);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span>{t(item.labelKey)}</span>
                    {"shortcut" in item && <kbd>{item.shortcut}</kbd>}
                  </button>
                ))
              )}
              {menu.id === "file" && recentProjects.length > 0 && (
                <>
                  <div className="app-menu-heading">{t("topbar.recentProjects")}</div>
                  {recentProjects.map((path) => (
                    <button
                      key={path}
                      onClick={() => {
                        close(true);
                        onOpenRecent(path);
                      }}
                      role="menuitem"
                      title={path}
                      type="button"
                    >
                      <span>{path.split(/[\\/]/).pop() || path}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
