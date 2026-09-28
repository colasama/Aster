// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider } from "../../state/editor-store";
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
      panels: ["inspector", "ai", "renderQueue"],
      activePanelId: "inspector",
    },
  },
  floating: [],
  closedPanels: ["project", "effects"],
  maximizedGroupId: "viewer",
};

function StateProbe() {
  const workspace = useWorkspaceController();
  return (
    <button type="button" onClick={() => workspace?.setPanelVisible("project", false)}>
      Close project
    </button>
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
            panels={[
              ["project", "Project"],
              ["effects", "Effects & Presets"],
              ["viewport", "Composition"],
              ["inspector", "Inspector"],
              ["ai", "AI Assistant"],
              ["renderQueue", "Render Queue"],
            ].map(([id, label]) => ({
              id,
              label,
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

it("brings panels to the front and exits another maximized group", () => {
  expect(nav("Inspector").getAttribute("aria-pressed")).toBe("false");
  act(() => nav("Inspector").click());
  expect(container.querySelector(".workspace-root")?.hasAttribute("data-maximized")).toBe(false);
  expect(nav("Inspector").getAttribute("aria-pressed")).toBe("true");
  act(() => nav("AI Assistant").click());
  expect(nav("Inspector").getAttribute("aria-pressed")).toBe("false");
  expect(nav("AI Assistant").getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[data-workspace-panel-surface="ai"]')).not.toBeNull();
  act(() => nav("Render Queue").click());
  expect(nav("AI Assistant").getAttribute("aria-pressed")).toBe("false");
  expect(nav("Render Queue").getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('.activity-bar button[aria-label="profiler"]')).toBeNull();
});

it("reopens closed panels beside their default companions and tracks closure", () => {
  act(() => nav("Effects & Presets").click());
  expect(container.querySelector('[data-workspace-panel-surface="effects"]')).not.toBeNull();
  expect(nav("Effects & Presets").getAttribute("aria-pressed")).toBe("true");
  act(() => nav("Project").click());
  expect(nav("Effects & Presets").getAttribute("aria-pressed")).toBe("false");
  expect(nav("Project").getAttribute("aria-pressed")).toBe("true");
  const projectGroup = [...container.querySelectorAll("[data-workspace-group]")].find((group) =>
    [...group.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent === "Project"),
  );
  expect(
    [...(projectGroup?.querySelectorAll('[role="tab"]') ?? [])].map((tab) => tab.textContent),
  ).toContain("Effects & Presets");
  const close = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Close project",
  );
  act(() => close?.click());
  expect(nav("Project").getAttribute("aria-pressed")).toBe("false");
});
