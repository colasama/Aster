// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, useEditor } from "../../state/editor-store";
import type { WorkspaceLayout } from "../../workspace/layout";
import { useWorkspaceController } from "../../workspace/workspace-controller";
import { DockWorkspace } from "../workspace/DockWorkspace";
import { ActivityBar } from "./ActivityBar";

let root: Root;
let container: HTMLDivElement;
const layout: WorkspaceLayout = {
  root: {
    kind: "split",
    id: "split",
    axis: "horizontal",
    ratio: 0.6,
    first: { kind: "tabGroup", id: "viewer", panels: ["viewport"], activePanelId: "viewport" },
    second: {
      kind: "tabGroup",
      id: "sidebar",
      panels: ["inspector", "renderQueue"],
      activePanelId: "inspector",
    },
  },
  floating: [],
  closedPanels: ["project"],
  maximizedGroupId: "viewer",
};

function StateProbe() {
  const { state } = useEditor();
  const workspace = useWorkspaceController();
  return (
    <>
      <output>{`${state.leftTab}/${state.rightTab}`}</output>
      <button type="button" onClick={() => workspace?.setPanelVisible("project", false)}>
        Close project
      </button>
    </>
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
        <EditorProvider>
          <ActivityBar />
          <StateProbe />
          <DockWorkspace
            initialLayout={layout}
            panels={["project", "viewport", "inspector", "renderQueue"].map((id) => ({
              id,
              label: id,
              element: <div>{id}</div>,
            }))}
          />
        </EditorProvider>
      </I18nProvider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
});

function nav(label: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `.activity-bar button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`Missing navigation: ${label}`);
  return button;
}

it("reveals a hidden sidebar, exits another maximized group and switches inspector tabs", () => {
  expect(nav("Properties").getAttribute("aria-pressed")).toBe("false");
  act(() => nav("Properties").click());
  expect(container.querySelector(".workspace-root")?.hasAttribute("data-maximized")).toBe(false);
  expect(nav("Properties").getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("output")?.textContent).toContain("/properties");
  act(() => nav("AI Assistant").click());
  expect(nav("Properties").getAttribute("aria-pressed")).toBe("false");
  expect(nav("AI Assistant").getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("output")?.textContent).toContain("/ai");
  act(() => nav("Render Queue").click());
  expect(nav("AI Assistant").getAttribute("aria-pressed")).toBe("false");
  expect(nav("Render Queue").getAttribute("aria-pressed")).toBe("true");
});

it("reopens a closed project panel into the requested subtab and tracks closure", () => {
  act(() => nav("Effects & Presets").click());
  expect(container.querySelector('[data-workspace-panel-surface="project"]')).not.toBeNull();
  expect(container.querySelector("output")?.textContent).toMatch(/^effects\//);
  expect(nav("Effects & Presets").getAttribute("aria-pressed")).toBe("true");
  act(() => nav("Project").click());
  expect(nav("Effects & Presets").getAttribute("aria-pressed")).toBe("false");
  expect(nav("Project").getAttribute("aria-pressed")).toBe("true");
  const close = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Close project",
  );
  act(() => close?.click());
  expect(nav("Project").getAttribute("aria-pressed")).toBe("false");
});
