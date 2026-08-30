// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopDisplayMetrics } from "../../desktop/api";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./context-menu-model";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  Object.defineProperty(window, "asterDesktop", { configurable: true, value: undefined });
});

function key(target: Element, value: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value }));
}

describe("ContextMenu", () => {
  it("renders through a portal, skips disabled items, runs a command, and restores focus", async () => {
    const trigger = document.createElement("button");
    document.body.prepend(trigger);
    trigger.focus();
    const run = vi.fn();
    const close = vi.fn();
    const items: ContextMenuItem[] = [
      {
        id: "disabled",
        kind: "command",
        label: "Disabled",
        disabled: true,
        disabledReason: "Nothing is selected",
        onSelect: vi.fn(),
      },
      { id: "run", kind: "command", label: "Run", onSelect: run },
    ];
    act(() =>
      root.render(
        <ContextMenu ariaLabel="Layer menu" items={items} onClose={close} open x={20} y={30} />,
      ),
    );
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.getAttribute("aria-label")).toBe("Layer menu");
    const disabled = document.body.querySelector('[aria-disabled="true"]');
    expect(disabled?.getAttribute("title")).toBe("Nothing is selected");
    expect(disabled?.getAttribute("aria-description")).toBe("Nothing is selected");
    expect(document.activeElement?.textContent).toBe("Run");
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(run).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        <ContextMenu
          ariaLabel="Layer menu"
          items={items}
          onClose={close}
          open={false}
          x={20}
          y={30}
        />,
      ),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("supports wraparound keyboard navigation, typeahead, and Escape", () => {
    const close = vi.fn();
    const items: ContextMenuItem[] = [
      { id: "alpha", kind: "command", label: "Alpha", onSelect: vi.fn() },
      { id: "separator", kind: "separator" },
      { id: "beta", kind: "command", label: "Beta", onSelect: vi.fn() },
    ];
    act(() =>
      root.render(<ContextMenu ariaLabel="Test" items={items} onClose={close} open x={0} y={0} />),
    );
    const menu = document.body.querySelector('[role="menu"]');
    if (!menu) throw new Error("Expected menu");
    act(() => key(menu, "ArrowUp"));
    expect(document.activeElement?.textContent).toBe("Beta");
    act(() => key(menu, "a"));
    expect(document.activeElement?.textContent).toBe("Alpha");
    act(() => key(menu, "Escape"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("opens submenus with the keyboard and returns with ArrowLeft", () => {
    const items: ContextMenuItem[] = [
      {
        id: "more",
        kind: "submenu",
        label: "More",
        items: [
          { id: "nested", kind: "checkbox", label: "Nested", checked: true, onSelect: vi.fn() },
        ],
      },
    ];
    act(() =>
      root.render(
        <ContextMenu ariaLabel="Test" items={items} onClose={vi.fn()} open x={0} y={0} />,
      ),
    );
    const rootMenu = document.body.querySelector('[aria-label="Test"]');
    if (!rootMenu) throw new Error("Expected root menu");
    act(() => key(rootMenu, "ArrowRight"));
    const nested = document.body.querySelector('[role="menuitemcheckbox"]');
    expect(nested?.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(nested);
    const submenu = nested?.closest('[role="menu"]');
    if (!submenu) throw new Error("Expected submenu");
    expect(submenu.parentElement).toBe(document.body);
    act(() => key(submenu, "ArrowLeft"));
    expect(document.body.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    expect(document.activeElement?.textContent).toContain("More");
  });

  it("closes on native display metrics so inline bounds cannot go stale after scaling", () => {
    let displayListener: ((metrics: DesktopDisplayMetrics) => void) | undefined;
    Object.defineProperty(window, "asterDesktop", {
      configurable: true,
      value: {
        onDisplayMetricsChanged(listener: (metrics: DesktopDisplayMetrics) => void) {
          displayListener = listener;
          return () => (displayListener = undefined);
        },
      },
    });
    const close = vi.fn();
    act(() =>
      root.render(
        <ContextMenu
          ariaLabel="Test"
          items={[{ id: "run", kind: "command", label: "Run", onSelect: vi.fn() }]}
          onClose={close}
          open
          x={700}
          y={500}
        />,
      ),
    );
    act(() =>
      displayListener?.({
        currentDisplayId: "display-2",
        deviceScaleFactor: 1.5,
        effectiveScaleFactor: 3,
        uiScale: 2,
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
