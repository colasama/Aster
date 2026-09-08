// @vitest-environment happy-dom

import { act, type ReactNode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/react";
import { AppMenuBar } from "./AppMenuBar";
import { CommandPalette } from "./CommandPalette";
import { Panel, PanelTabs } from "./Panel";
import { WorkspacePanelHostContext } from "./workspace/WorkspacePanelHost";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
});
function render(node: ReactNode) {
  act(() => root.render(<I18nProvider>{node}</I18nProvider>));
}
function key(target: EventTarget, value: string, options: KeyboardEventInit = {}) {
  act(() =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }),
    ),
  );
}
function button(text: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === text,
  );
  if (!result) throw new Error(`Missing ${text}`);
  return result;
}
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("selects palette results with arrow keys, resets selection on filtering and ignores IME Enter", () => {
  const actions = [vi.fn(), vi.fn()];
  const close = vi.fn();
  render(
    <CommandPalette
      commands={[
        { label: "Alpha", action: actions[0] },
        { label: "Beta", action: actions[1] },
      ]}
      onClose={close}
    />,
  );
  const input = container.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("Missing input");
  expect(document.activeElement).toBe(input);
  key(input, "ArrowDown");
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe("Beta");
  key(input, "Enter", { isComposing: true });
  expect(close).not.toHaveBeenCalled();
  type(input, "missing");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("No matching commands");
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  key(input, "Enter");
  expect(close).not.toHaveBeenCalled();
  type(input, "  alpha  ");
  key(input, "Enter");
  expect(actions[0]).toHaveBeenCalledOnce();
  expect(actions[1]).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
it("keeps palette Tab focus out of arrow-navigated options and dismisses on outside click", () => {
  const close = vi.fn();
  render(<CommandPalette commands={[{ label: "Alpha", action: vi.fn() }]} onClose={close} />);
  const input = container.querySelector("input");
  if (!input) throw new Error("Missing input");
  key(input, "Tab");
  expect(document.activeElement).toBe(container.querySelector(".palette-close"));
  key(document.activeElement as HTMLElement, "Tab");
  expect(document.activeElement).toBe(input);
  act(() =>
    container
      .querySelector(".modal-backdrop")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
  );
  expect(close).toHaveBeenCalledOnce();
});
it("navigates menus, restores the trigger with Escape, and closes without stealing outside focus", () => {
  render(
    <>
      <AppMenuBar recentProjects={["E:/project.aster"]} onAction={vi.fn()} onOpenRecent={vi.fn()} />
      <button type="button">Outside</button>
    </>,
  );
  key(button("File"), "ArrowDown");
  expect(document.activeElement).toBe(container.querySelector('[role="menuitem"]'));
  key(document.activeElement as HTMLElement, "End");
  expect(document.activeElement?.textContent).toBe("project.aster");
  key(document.activeElement as HTMLElement, "ArrowRight");
  expect(button("Edit").getAttribute("aria-expanded")).toBe("true");
  key(document.activeElement as HTMLElement, "Escape");
  expect(document.activeElement).toBe(button("Edit"));
  expect(container.querySelector('[role="menu"]')).toBeNull();
  act(() => button("File").click());
  act(() => {
    button("Outside").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    button("Outside").focus();
  });
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(button("Outside"));
});
it("preserves a portalled modal when interacting outside the menu DOM", () => {
  render(<AppMenuBar recentProjects={[]} onAction={vi.fn()} onOpenRecent={vi.fn()} />);
  act(() => button("File").click());
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  act(() => dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(container.querySelector('[role="menu"]')).not.toBeNull();
});
it("keeps embedded subtabs in their own row and supports roving keyboard focus", () => {
  function Harness() {
    const [active, setActive] = useState("a");
    const [host, setHost] = useState<HTMLElement | null>(null);
    useEffect(() => setHost(document.querySelector(".test-host")), []);
    return (
      <>
        <div className="test-host" />
        <WorkspacePanelHostContext value={{ headerHost: host }}>
          <Panel
            actions={<button type="button">Action</button>}
            tabs={
              <PanelTabs
                active={active}
                onChange={setActive}
                tabs={[
                  { id: "a", label: "A" },
                  { id: "b", label: "B" },
                ]}
              />
            }
          >
            Body
          </Panel>
        </WorkspacePanelHostContext>
      </>
    );
  }
  render(<Harness />);
  expect(container.querySelector(".test-host .panel-tabs")).toBeNull();
  expect(container.querySelector(".test-host .panel-actions")).not.toBeNull();
  expect(container.querySelector(".panel-subheader .panel-tabs")).not.toBeNull();
  key(button("A"), "ArrowRight");
  expect(button("B").tabIndex).toBe(0);
  expect(button("A").tabIndex).toBe(-1);
  expect(document.activeElement).toBe(button("B"));
  key(button("B"), "Home");
  expect(document.activeElement).toBe(button("A"));
});
