// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { activeComposition, createBlankProject } from "../../core/project/project";
import type { Project } from "../../core/types";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, useEditor } from "../../state/editor-store";
import { useWorkspaceController } from "../../workspace/workspace-controller";
import { DockWorkspace } from "../workspace/DockWorkspace";
import { WorkspaceTimelineSurface } from "../workspace/WorkspacePanelSurfaces";

let root: Root;
let editor: ReturnType<typeof useEditor>;
let workspace: ReturnType<typeof useWorkspaceController>;
function Observe({ project }: { project: Project }) {
  const current = useEditor();
  editor = current;
  workspace = useWorkspaceController();
  const { dispatch } = current;
  useEffect(() => {
    dispatch({ type: "loadProject", project });
    dispatch({ type: "selectKeyframes", ids: ["key"] });
  }, [dispatch, project]);
  return null;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.localStorage.setItem("aster.locale", "en-US");
  const project = createBlankProject(true);
  const composition = activeComposition(project);
  const layer = createLayerForComposition("solid", composition);
  layer.locked = true;
  layer.transform.opacity = {
    mode: "animated",
    keyframes: [{ id: "key", time: 0, value: 50, interpolation: "linear" }],
  };
  composition.layers = [layer];
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <EditorProvider>
          <Observe project={project} />
          <DockWorkspace
            initialLayout={{
              root: {
                kind: "tabGroup",
                id: "group",
                panels: ["timeline", "other"],
                activePanelId: "timeline",
              },
              floating: [],
              closedPanels: [],
            }}
            panels={[
              {
                id: "timeline",
                label: "Timeline",
                element: <WorkspaceTimelineSurface mode="timeline" />,
              },
              { id: "other", label: "Other", element: <div>Other content</div> },
            ]}
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
function press(key: string, options: KeyboardEventInit = {}) {
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
    ),
  );
}
it("protects locked keyframes from keyboard delete and paste while allowing copy", () => {
  const original = editor.state.project;
  press("c", { ctrlKey: true });
  press("Delete");
  press("v", { ctrlKey: true });
  expect(editor.state.project).toBe(original);
  expect(editor.state.history.past).toHaveLength(0);
  expect(editor.state.selectedKeyframes).toEqual(["key"]);
  act(() =>
    editor.dispatch({
      type: "operation",
      operations: [
        { type: "toggleLayer", layerId: activeComposition(original).layers[0].id, field: "locked" },
      ],
    }),
  );
  press("Delete");
  expect(editor.state.selectedKeyframes).toHaveLength(0);
  expect(editor.state.history.past).toHaveLength(2);
});
it("does not seek or delete behind a modal or during IME composition", () => {
  const originalTime = editor.state.currentTime;
  press("PageDown", { isComposing: true });
  expect(editor.state.currentTime).toBe(originalTime);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  press("Home");
  press("Delete");
  expect(editor.state.currentTime).toBe(originalTime);
  expect(editor.state.selectedKeyframes).toEqual(["key"]);
});
it("removes duplicate timeline mode tabs and reveals an already docked inactive panel", () => {
  expect(document.querySelector(".timeline-panel .panel-tabs")).toBeNull();
  act(() => workspace?.setPanelVisible("other", true));
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Other");
  act(() => workspace?.setPanelVisible("timeline", true));
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "Timeline",
  );
});
