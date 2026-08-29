// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/react";
import { WORKSPACE_LAYOUT_STORAGE_KEY } from "../../workspace/layout-storage";
import { WORKSPACE_CATALOG_STORAGE_KEY } from "../../workspace/named-workspaces";
import { Panel } from "../Panel";
import { DockWorkspace } from "./DockWorkspace";
import { WorkspaceWindowMenu } from "./WorkspaceWindowMenu";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
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

describe("WorkspaceWindowMenu", () => {
  it("restores the current built-in workspace when no live layout exists", () => {
    window.localStorage.setItem(
      WORKSPACE_CATALOG_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, currentWorkspaceId: "minimal", customWorkspaces: [] }),
    );
    act(() =>
      root.render(
        <I18nProvider>
          <DockWorkspace
            panels={[
              { id: "project", label: "Project", element: <Panel title="Project" /> },
              { id: "viewport", label: "Composition", element: <Panel title="Composition" /> },
              { id: "inspector", label: "Inspector", element: <Panel title="Inspector" /> },
              { id: "timeline", label: "Timeline", element: <Panel title="Timeline" /> },
              { id: "graph", label: "Graph Editor", element: <Panel title="Graph Editor" /> },
              { id: "profiler", label: "Profiler", element: <Panel title="Profiler" /> },
            ]}
          />
          <div className="app-menu-popover">
            <WorkspaceWindowMenu onClose={vi.fn()} />
          </div>
        </I18nProvider>,
      ),
    );
    expect(container.querySelectorAll('.workspace-tabs [role="tab"]')).toHaveLength(1);
    expect(container.querySelector('.workspace-tabs [role="tab"]')?.textContent).toBe(
      "Composition",
    );
    expect(
      [...container.querySelectorAll('[role="menuitemradio"]')]
        .find((item) => item.textContent?.includes("Minimal"))
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("saves a de-duplicated named workspace and confirms custom deletion", () => {
    const close = vi.fn();
    act(() =>
      root.render(
        <I18nProvider>
          <DockWorkspace
            panels={[
              { id: "project", label: "Project", element: <Panel title="Project" /> },
              { id: "viewport", label: "Composition", element: <Panel title="Composition" /> },
              { id: "inspector", label: "Inspector", element: <Panel title="Inspector" /> },
              { id: "timeline", label: "Timeline", element: <Panel title="Timeline" /> },
              { id: "graph", label: "Graph Editor", element: <Panel title="Graph Editor" /> },
              { id: "profiler", label: "Profiler", element: <Panel title="Profiler" /> },
            ]}
          />
          <div className="app-menu-popover">
            <WorkspaceWindowMenu onClose={close} />
          </div>
        </I18nProvider>,
      ),
    );
    const saveAs = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.includes("Save Workspace As"),
    );
    act(() => saveAs?.click());
    const form = document.body.querySelector<HTMLFormElement>('[role="dialog"]');
    expect(form).not.toBeNull();
    act(() => form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })));
    const catalog = JSON.parse(
      window.localStorage.getItem(WORKSPACE_CATALOG_STORAGE_KEY) ?? "null",
    );
    expect(catalog).toMatchObject({
      schemaVersion: 1,
      currentWorkspaceId: "custom-default-2-1",
      customWorkspaces: [{ name: "Default 2" }],
    });
    const projectToggle = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
    ].find((button) => button.textContent?.includes("Project"));
    act(() => projectToggle?.click());
    expect(
      JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null"),
    ).toMatchObject({ closedPanels: ["project"] });
    const reset = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.includes("Reset to Saved Layout"),
    );
    act(() => reset?.click());
    expect(
      JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null"),
    ).toMatchObject({ closedPanels: [] });
    const deleteButton = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes("Delete Workspace"));
    act(() => deleteButton?.click());
    const confirm = document.body.querySelector<HTMLFormElement>('[role="dialog"]');
    expect(confirm?.textContent).toContain("Delete Default 2?");
    act(() =>
      confirm?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })),
    );
    expect(
      JSON.parse(window.localStorage.getItem(WORKSPACE_CATALOG_STORAGE_KEY) ?? "null"),
    ).toMatchObject({ currentWorkspaceId: "default", customWorkspaces: [] });
  });

  it("checks all panel visibility and closes a panel through the Window menu", () => {
    act(() =>
      root.render(
        <I18nProvider>
          <DockWorkspace
            initialLayout={{
              root: {
                kind: "tabGroup",
                id: "only-group",
                panels: ["project", "viewport"],
                activePanelId: "project",
              },
              floating: [],
              closedPanels: [],
            }}
            panels={[
              { id: "project", label: "Project", element: <Panel title="Project" /> },
              { id: "viewport", label: "Composition", element: <Panel title="Composition" /> },
            ]}
          />
          <div className="app-menu-popover">
            <WorkspaceWindowMenu onClose={vi.fn()} />
          </div>
        </I18nProvider>,
      ),
    );
    const panels = container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]');
    expect([...panels].map((panel) => panel.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
    ]);
    act(() => panels[0]?.click());
    expect(
      JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null"),
    ).toMatchObject({ closedPanels: ["project"] });
  });
});
