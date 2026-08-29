// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/react";
import type { WorkspaceLayout } from "../../workspace/layout";
import { WORKSPACE_LAYOUT_STORAGE_KEY } from "../../workspace/layout-storage";
import { Panel } from "../Panel";
import { DockWorkspace, useWorkspaceApi } from "./DockWorkspace";
import { useWorkspaceViewerIdentity } from "./WorkspaceViewerIdentity";

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
  const viewer = useWorkspaceViewerIdentity();
  return (
    <Panel actions={<button type="button">Surface action</button>} title={name}>
      <span>{name} body</span>
      {viewer ? (
        <span data-viewer-context={`${viewer.id}:${viewer.locked}:${viewer.contextId ?? ""}`} />
      ) : null}
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
          viewerContextId="composition-1"
          panels={[
            {
              id: "a",
              label: "A",
              element: <Surface name="A" />,
              viewerType: "composition",
            },
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
    expect(
      container.querySelector('[data-workspace-panel-surface="a"]')?.hasAttribute("hidden"),
    ).toBe(true);
    expect(container.querySelector('[data-workspace-panel-surface="b"]')).not.toBeNull();
    expect(container.querySelector(".workspace-panel-header-host")?.textContent).toBe(
      "Surface action",
    );
  });

  it("reorders active tabs from the keyboard as one persisted workspace change", () => {
    const firstTab = container.querySelector<HTMLButtonElement>('[role="tab"]');
    act(() =>
      firstTab?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          ctrlKey: true,
          key: "PageDown",
          shiftKey: true,
        }),
      ),
    );
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      "B",
      "A",
    ]);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("A");
    expect(
      JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null"),
    ).toMatchObject({ root: { panels: ["b", "a"], activePanelId: "a" } });
  });

  it("cycles tabs from the wheel without moving keyboard focus", () => {
    const tabList = container.querySelector<HTMLElement>('[role="tablist"]');
    const firstTab = container.querySelector<HTMLButtonElement>('[role="tab"]');
    firstTab?.focus();
    act(() =>
      tabList?.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }),
      ),
    );
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("B");
    expect(document.activeElement).toBe(firstTab);
  });

  it("closes the focused panel or panel group with AE keyboard commands", () => {
    const firstTab = container.querySelector<HTMLButtonElement>('[role="tab"]');
    firstTab?.focus();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "w" }),
      ),
    );
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    const remainingTab = container.querySelector<HTMLButtonElement>('[role="tab"]');
    remainingTab?.focus();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          ctrlKey: true,
          key: "w",
          shiftKey: true,
        }),
      ),
    );
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container.querySelector(".workspace-empty")).not.toBeNull();
  });

  it("closes and reopens panels through the workspace API and persists a versioned commit", () => {
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Close A"]')?.click());
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null");
    expect(stored).toMatchObject({ schemaVersion: 2, closedPanels: ["a"] });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(".workspace-group-content button:last-of-type")
        ?.click(),
    );
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });

  it("switches to a persisted stacked group and applies AE solo and simultaneous expansion", () => {
    const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (candidate) => candidate.textContent === "A",
    );
    act(() =>
      tab?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
      ),
    );
    const groupSettings = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((candidate) => candidate.textContent?.includes("Panel Group Settings"));
    act(() => groupSettings?.click());
    const stacked = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ].find((candidate) => candidate.textContent?.includes("Stacked Panel Group"));
    act(() => stacked?.click());
    expect(container.querySelector(".workspace-stack")).not.toBeNull();
    expect(container.querySelectorAll(".workspace-stack-panel")).toHaveLength(2);
    expect(container.querySelectorAll('[aria-expanded="true"]')).toHaveLength(1);

    const b = [...container.querySelectorAll<HTMLButtonElement>(".workspace-stack-toggle")].find(
      (candidate) => candidate.textContent?.includes("B"),
    );
    act(() => b?.click());
    expect(container.querySelectorAll('[aria-expanded="true"]')).toHaveLength(1);
    expect(b?.getAttribute("aria-expanded")).toBe("true");
    act(() => b?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    expect(container.querySelectorAll('[aria-expanded="true"]')).toHaveLength(0);
  });

  it("locks the current viewer and creates an unlocked split identity with the AE shortcut", () => {
    const activeTab = container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]',
    );
    act(() => activeTab?.focus());
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
          key: "n",
        }),
      ),
    );
    expect(container.querySelectorAll("[data-workspace-group]")).toHaveLength(2);
    expect(container.textContent).toContain("A 2");
    expect(container.querySelectorAll('button[aria-label="Unlock viewer"]')).toHaveLength(1);
    expect(container.querySelectorAll('button[aria-label="Lock viewer"]')).toHaveLength(1);
    expect(container.querySelectorAll(".workspace-group-content .panel")).toHaveLength(2);
    expect(
      [...container.querySelectorAll("[data-viewer-context]")].map((candidate) =>
        candidate.getAttribute("data-viewer-context"),
      ),
    ).toEqual(["a:true:composition-1", "a::viewer-2:false:composition-1"]);
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
