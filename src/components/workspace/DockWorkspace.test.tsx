// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/react";
import type { WorkspaceLayout } from "../../workspace/layout";
import { WORKSPACE_LAYOUT_STORAGE_KEY } from "../../workspace/layout-storage";
import { Panel } from "../Panel";
import { DockWorkspace, useWorkspaceApi } from "./DockWorkspace";

let container: HTMLDivElement;
let root: Root;

const initialLayout: WorkspaceLayout = {
  root: {
    kind: "tabGroup",
    id: "group",
    panels: ["a", "b"],
    activePanelId: "a",
  },
  floating: [],
  closedPanels: [],
};

function Surface({ name }: { readonly name: string }) {
  const workspace = useWorkspaceApi();
  return (
    <Panel actions={<button type="button">Surface action</button>} title={name}>
      <span>{name} body</span>
      <button onClick={() => workspace.reopen("a", "group")} type="button">
        Reopen A
      </button>
    </Panel>
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.localStorage.setItem("aster.locale", "en-US");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <DockWorkspace
          initialLayout={initialLayout}
          panels={[
            { id: "a", label: "A", element: <Surface name="A" /> },
            { id: "b", label: "B", element: <Surface name="B" /> },
          ]}
        />
      </I18nProvider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("DockWorkspace", () => {
  it("renders accessible tabs, merges Panel actions, and supports keyboard overflow navigation", () => {
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("A");
    expect(container.querySelector(".workspace-panel-header-host")?.textContent).toContain(
      "Surface action",
    );
    const activeTab = container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]',
    );
    act(() =>
      activeTab?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })),
    );
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("B");
    expect(container.textContent).toContain("B body");
  });

  it("closes and reopens panels through the workspace API and persists a versioned commit", () => {
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Close A"]')?.click());
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null");
    expect(stored).toMatchObject({ schemaVersion: 1, closedPanels: ["a"] });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(".workspace-group-content button:last-of-type")
        ?.click(),
    );
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });

  it("maximizes and restores the hovered group with the AE-style header gesture", () => {
    const header = container.querySelector(".workspace-group-header");
    act(() => header?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(container.querySelector(".workspace-root")?.getAttribute("data-maximized")).toBe("true");
    act(() => header?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(container.querySelector(".workspace-root")?.hasAttribute("data-maximized")).toBe(false);
  });

  it("runs the tab context menu as one persisted transaction and supports undo", () => {
    const tab = container.querySelector<HTMLButtonElement>('[role="tab"]');
    act(() =>
      tab?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 50 }),
      ),
    );
    const closeOthers = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes("Close Others"));
    expect(closeOthers).toBeDefined();
    act(() => closeOthers?.click());
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(
      JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null"),
    ).toMatchObject({ closedPanels: ["b"] });
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { altKey: true, bubbles: true, ctrlKey: true, key: "z" }),
      ),
    );
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });
});
