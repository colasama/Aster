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
  const project = createBlankProject();
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

it("uses AE frame steps, work-area navigation, and the last visible frame", () => {
  const composition = activeComposition(editor.state.project);
  const frame = composition.frameRate.denominator / composition.frameRate.numerator;
  act(() => editor.dispatch({ type: "setTime", time: 2 }));
  press("PageDown", { shiftKey: true });
  expect(editor.state.currentTime).toBeCloseTo(2 + 10 * frame);
  press("ArrowLeft", { ctrlKey: true });
  expect(editor.state.currentTime).toBeCloseTo(2 + 9 * frame);
  press("ArrowLeft", { metaKey: true, shiftKey: true });
  expect(editor.state.currentTime).toBeCloseTo(2 - frame);
  press("b");
  const start = editor.state.currentTime;
  press("PageDown", { shiftKey: true });
  press("n");
  const end = editor.state.currentTime;
  press("Home", { shiftKey: true });
  expect(editor.state.currentTime).toBeCloseTo(start);
  press("End", { shiftKey: true });
  expect(editor.state.currentTime).toBeCloseTo(end);
  press("End");
  expect(editor.state.currentTime).toBeCloseTo(composition.duration - frame);
  press("PageDown");
  expect(editor.state.currentTime).toBeCloseTo(composition.duration - frame);
  press("ArrowLeft", { ctrlKey: true, altKey: true });
  expect(editor.state.currentTime).toBe(0);
});

it("zooms around the playhead and restores both scale and scroll after fitting", () => {
  const scroll = document.querySelector<HTMLDivElement>(".timeline-scroll");
  if (!scroll) throw new Error("Missing timeline");
  act(() => editor.dispatch({ type: "setTime", time: 4 }));
  scroll.scrollLeft = 120;
  const playheadX = 4 * 82 - scroll.scrollLeft;
  press("=");
  expect(editor.state.timelineZoom).toBe(1.25);
  expect(4 * 82 * editor.state.timelineZoom - scroll.scrollLeft).toBeCloseTo(playheadX);
  const previousScroll = scroll.scrollLeft;
  press(":", { code: "Semicolon", shiftKey: true });
  expect(scroll.scrollLeft).toBe(0);
  expect(
    editor.state.timelineZoom * 82 * activeComposition(editor.state.project).duration,
  ).toBeCloseTo(1000 - 286);
  press(":", { code: "Semicolon", shiftKey: true });
  expect(editor.state.timelineZoom).toBe(1.25);
  expect(scroll.scrollLeft).toBeCloseTo(previousScroll);
  press(";", { code: "Semicolon" });
  expect(editor.state.timelineZoom).toBeCloseTo((24 * 30) / 82);
  press("d");
  expect(4 * 82 * editor.state.timelineZoom - scroll.scrollLeft).toBeCloseTo((1000 - 286) / 2);
  press(";", { code: "Semicolon" });
  expect(scroll.scrollLeft).toBe(0);
  expect(editor.state.history.past).toHaveLength(0);
});

it("anchors Alt-wheel zoom to the pointer, pans with Shift, and leaves normal scrolling native", () => {
  const scroll = document.querySelector<HTMLDivElement>(".timeline-scroll");
  if (!scroll) throw new Error("Missing timeline");
  scroll.scrollLeft = 100;
  const anchorTime = (100 + 500 - 286) / 82;
  const wheel = (options: WheelEventInit) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 500,
      deltaY: -100,
      ...options,
    });
    // happy-dom's WheelEvent inherits UIEvent rather than MouseEvent.
    Object.assign(event, {
      clientX: 500,
      altKey: false,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      ...options,
    });
    act(() => scroll.dispatchEvent(event));
    return event;
  };
  expect(wheel({ altKey: true }).defaultPrevented).toBe(true);
  expect((scroll.scrollLeft + 500 - 286) / (82 * editor.state.timelineZoom)).toBeCloseTo(
    anchorTime,
  );
  const previous = scroll.scrollLeft;
  expect(wheel({ shiftKey: true, deltaY: 3, deltaMode: 1 }).defaultPrevented).toBe(true);
  expect(scroll.scrollLeft).toBe(previous + 48);
  const zoom = editor.state.timelineZoom;
  expect(wheel({}).defaultPrevented).toBe(false);
  expect(editor.state.timelineZoom).toBe(zoom);
});

it("does not steal zoom shortcuts from text entry, modifiers, or modal surfaces", () => {
  const input = document.createElement("input");
  document.body.append(input);
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "=", bubbles: true, cancelable: true }),
    ),
  );
  press("=", { ctrlKey: true });
  press("=", { shiftKey: true });
  press(";", { altKey: true });
  press(";", { isComposing: true });
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  press("=");
  expect(editor.state.timelineZoom).toBe(1);
});
