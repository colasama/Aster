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
import { timelineZoomStore } from "./timeline-zoom-store";

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
  timelineZoomStore.set(1);
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
it("copies, pastes, duplicates and deletes layers with Ctrl+C/V/D/Delete", () => {
  const layerId = activeComposition(editor.state.project).layers[0].id;
  act(() => {
    // The fixture layer starts locked; unlock it so clipboard edits apply.
    editor.dispatch({
      type: "operation",
      operations: [{ type: "toggleLayer", layerId, field: "locked" }],
    });
    editor.dispatch({ type: "selectKeyframes", ids: [] });
    editor.dispatch({ type: "select", ids: [layerId] });
    editor.dispatch({ type: "setTime", time: 3 });
  });
  press("c", { ctrlKey: true });
  press("v", { ctrlKey: true });
  let layers = activeComposition(editor.state.project).layers;
  expect(layers).toHaveLength(2);
  const pasted = layers.find((layer) => layer.id !== layerId);
  expect(pasted?.inPoint).toBeCloseTo(3);
  expect(editor.state.selection).toEqual([pasted?.id]);
  press("d", { ctrlKey: true });
  layers = activeComposition(editor.state.project).layers;
  expect(layers).toHaveLength(3);
  expect(new Set(layers.map((layer) => layer.id)).size).toBe(3);
  press("Delete");
  layers = activeComposition(editor.state.project).layers;
  expect(layers).toHaveLength(2);
  // Locked layers are skipped instead of blocking the whole delete.
  act(() => {
    editor.dispatch({
      type: "operation",
      operations: [{ type: "toggleLayer", layerId, field: "locked" }],
    });
    editor.dispatch({ type: "select", ids: [layerId] });
  });
  press("Delete");
  expect(activeComposition(editor.state.project).layers).toHaveLength(2);
});

it("splits layers at the playhead with Ctrl+Shift+D and clears selection with Escape", () => {
  const layerId = activeComposition(editor.state.project).layers[0].id;
  act(() => {
    editor.dispatch({
      type: "operation",
      operations: [{ type: "toggleLayer", layerId, field: "locked" }],
    });
    editor.dispatch({ type: "selectKeyframes", ids: [] });
    editor.dispatch({ type: "select", ids: [layerId] });
    editor.dispatch({ type: "setTime", time: 2 });
  });
  press("d", { ctrlKey: true, shiftKey: true });
  const layers = activeComposition(editor.state.project).layers;
  expect(layers).toHaveLength(2);
  const left = layers.find((layer) => layer.id === layerId);
  const right = layers.find((layer) => layer.id !== layerId);
  expect(left?.outPoint).toBeCloseTo(2);
  expect(right?.inPoint).toBeCloseTo(2);
  press("Escape");
  expect(editor.state.selection).toEqual([]);
});

it("seeks from the editable timeline timecode after validating on Enter", () => {
  const input = document.querySelector<HTMLInputElement>(".timecode .preview-timecode");
  if (!input) throw new Error("Missing timeline timecode");
  const setValue = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  act(() => {
    input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    setValue("bogus");
  });
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(editor.state.currentTime).toBe(0);
  act(() => setValue("00:00:02:00"));
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
  expect(editor.state.currentTime).toBeCloseTo(2);
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

it("scrolls in either direction to reveal keyboard frame steps without adding history", () => {
  const scroll = document.querySelector<HTMLDivElement>(".timeline-scroll");
  if (!scroll) throw new Error("Missing timeline");
  Object.defineProperty(scroll, "clientWidth", { value: 600 });
  act(() => timelineZoomStore.set(100 / 82));
  scroll.scrollLeft = 200;
  act(() => editor.dispatch({ type: "setTime", time: 5.1 }));
  press("ArrowRight", { ctrlKey: true });
  expect(scroll.scrollLeft).toBeGreaterThan(200);
  expect(editor.state.currentTime * 100 - scroll.scrollLeft).toBeLessThanOrEqual(314 - 48);
  const previous = scroll.scrollLeft;
  act(() => editor.dispatch({ type: "setTime", time: previous / 100 }));
  press("ArrowLeft", { ctrlKey: true });
  expect(scroll.scrollLeft).toBeLessThan(previous);
  expect(editor.state.currentTime * 100 - scroll.scrollLeft).toBeCloseTo(48);
  const visible = scroll.scrollLeft;
  act(() => editor.dispatch({ type: "setTime", time: (visible + 150) / 100 }));
  press("PageDown");
  expect(scroll.scrollLeft).toBe(visible);
  expect(editor.state.history.past).toHaveLength(0);
});

it("previews all layer key markers, cancels cleanly and commits the move as one undo step", async () => {
  const project = structuredClone(editor.state.project);
  const layer = activeComposition(project).layers[0];
  layer.locked = false;
  layer.inPoint = 2;
  layer.outPoint = 6;
  layer.transform.opacity = {
    mode: "animated",
    keyframes: [{ id: "key", time: 2.5, value: 50, interpolation: "linear" }],
  };
  act(() => editor.dispatch({ type: "loadProject", project }));
  const expand = document.querySelector<HTMLButtonElement>(".layer-label > button");
  act(() => expand?.click());
  const bar = document.querySelector<HTMLDivElement>(".layer-bar");
  if (!bar) throw new Error("Missing layer bar");
  const drag = async () => {
    act(() =>
      bar.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 9, clientX: 500 }),
      ),
    );
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 9, clientX: 664, ctrlKey: true }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  };
  await drag();
  const markers = [...document.querySelectorAll<HTMLButtonElement>(".keyframe")];
  expect(markers.length).toBeGreaterThan(1);
  expect(markers.every((marker) => marker.getAttribute("aria-label")?.includes("4.50"))).toBe(true);
  expect(editor.state.project).toBe(project);
  press("Escape");
  expect(editor.state.history.past).toHaveLength(0);
  expect(markers.every((marker) => marker.getAttribute("aria-label")?.includes("2.50"))).toBe(true);
  await drag();
  act(() =>
    window.dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 9, clientX: 664, ctrlKey: true }),
    ),
  );
  const moved = activeComposition(editor.state.project).layers[0];
  expect(moved).toMatchObject({ inPoint: 4, outPoint: 8 });
  expect(moved.transform.opacity).toMatchObject({ keyframes: [{ id: "key", time: 4.5 }] });
  expect(editor.state.history.past).toHaveLength(1);
  act(() => editor.dispatch({ type: "undo" }));
  expect(activeComposition(editor.state.project).layers[0]).toEqual(layer);
  act(() => editor.dispatch({ type: "redo" }));
  expect(activeComposition(editor.state.project).layers[0]).toEqual(moved);
});

it("moves keys with bracket alignment while Alt+bracket only trims", () => {
  const project = structuredClone(editor.state.project);
  const layer = activeComposition(project).layers[0];
  layer.locked = false;
  layer.inPoint = 2;
  layer.outPoint = 6;
  act(() => {
    editor.dispatch({ type: "loadProject", project });
    editor.dispatch({ type: "select", ids: [layer.id] });
    editor.dispatch({ type: "selectKeyframes", ids: [] });
    editor.dispatch({ type: "setTime", time: 3 });
  });
  press("[", { code: "BracketLeft" });
  let moved = activeComposition(editor.state.project).layers[0];
  expect(moved).toMatchObject({ inPoint: 3, outPoint: 7 });
  expect(moved.transform.opacity).toMatchObject({ keyframes: [{ time: 1 }] });
  act(() => editor.dispatch({ type: "setTime", time: 4 }));
  press("[", { code: "BracketLeft", altKey: true });
  moved = activeComposition(editor.state.project).layers[0];
  expect(moved).toMatchObject({ inPoint: 4, outPoint: 7 });
  expect(moved.transform.opacity).toMatchObject({ keyframes: [{ time: 1 }] });
});

it("zooms around the playhead and restores both scale and scroll after fitting", () => {
  const scroll = document.querySelector<HTMLDivElement>(".timeline-scroll");
  if (!scroll) throw new Error("Missing timeline");
  act(() => editor.dispatch({ type: "setTime", time: 4 }));
  scroll.scrollLeft = 120;
  const playheadX = 4 * 82 - scroll.scrollLeft;
  press("=");
  expect(timelineZoomStore.get()).toBe(1.25);
  expect(4 * 82 * timelineZoomStore.get() - scroll.scrollLeft).toBeCloseTo(playheadX);
  const previousScroll = scroll.scrollLeft;
  press(":", { code: "Semicolon", shiftKey: true });
  expect(scroll.scrollLeft).toBe(0);
  expect(
    timelineZoomStore.get() * 82 * activeComposition(editor.state.project).duration,
  ).toBeCloseTo(1000 - 286);
  press(":", { code: "Semicolon", shiftKey: true });
  expect(timelineZoomStore.get()).toBe(1.25);
  expect(scroll.scrollLeft).toBeCloseTo(previousScroll);
  press(";", { code: "Semicolon" });
  expect(timelineZoomStore.get()).toBeCloseTo((24 * 30) / 82);
  press("d");
  expect(4 * 82 * timelineZoomStore.get() - scroll.scrollLeft).toBeCloseTo((1000 - 286) / 2);
  press(";", { code: "Semicolon" });
  expect(scroll.scrollLeft).toBe(0);
  expect(editor.state.history.past).toHaveLength(0);
});

it.each([
  { scrollLeft: 83, zoom: 1 },
  { scrollLeft: 217, zoom: 2 },
])("keeps ruler drags out of the property column at $zoom zoom", async ({ scrollLeft, zoom }) => {
  const scroll = document.querySelector<HTMLDivElement>(".timeline-scroll");
  const ruler = document.querySelector<HTMLDivElement>(".time-ruler");
  if (!scroll || !ruler) throw new Error("Missing timeline");
  act(() => timelineZoomStore.set(zoom));
  scroll.scrollLeft = scrollLeft;
  const composition = activeComposition(editor.state.project);
  const frame = composition.frameRate.denominator / composition.frameRate.numerator;
  const firstVisibleFrame = Math.ceil(scrollLeft / (82 * zoom) / frame) * frame;
  act(() => editor.dispatch({ type: "setTime", time: firstVisibleFrame - frame }));
  act(() =>
    ruler.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 486 }),
    ),
  );
  expect(editor.state.currentTime).toBeGreaterThan(firstVisibleFrame);
  for (const clientX of [287, 80]) {
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(editor.state.currentTime * 82 * zoom - scroll.scrollLeft).toBeGreaterThanOrEqual(-1e-7);
    expect(editor.state.currentTime * 82 * zoom - scroll.scrollLeft).toBeLessThan(
      8 + frame * 82 * zoom,
    );
  }
  act(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, clientX: 0 })));
  expect(editor.state.currentTime * 82 * zoom - scroll.scrollLeft).toBeGreaterThanOrEqual(-1e-7);
  expect(editor.state.currentTime * 82 * zoom - scroll.scrollLeft).toBeLessThan(
    8 + frame * 82 * zoom,
  );
});

it.each([
  { scrollLeft: 83, zoom: 1, width: 700, ctrlKey: false },
  { scrollLeft: 217, zoom: 2, width: 500, ctrlKey: true },
])(
  "keeps ruler drags inside the right edge at $zoom zoom",
  async ({ scrollLeft, zoom, width, ctrlKey }) => {
    const scroll = document.querySelector<HTMLDivElement>(".timeline-scroll");
    const ruler = document.querySelector<HTMLDivElement>(".time-ruler");
    if (!scroll || !ruler) throw new Error("Missing timeline");
    Object.defineProperty(scroll, "clientWidth", { value: width });
    act(() => timelineZoomStore.set(zoom));
    scroll.scrollLeft = scrollLeft;
    const composition = activeComposition(editor.state.project);
    const frame = composition.frameRate.denominator / composition.frameRate.numerator;
    const lastVisibleFrame =
      Math.floor((scrollLeft + width - 286 - 1) / (82 * zoom) / frame) * frame;
    act(() => editor.dispatch({ type: "setTime", time: lastVisibleFrame + frame }));
    act(() =>
      ruler.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 386 }),
      ),
    );
    expect(editor.state.currentTime).toBeLessThan(lastVisibleFrame);
    for (const clientX of [width - 1, width + 200]) {
      await act(async () => {
        window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX, ctrlKey }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(286 + editor.state.currentTime * 82 * zoom - scroll.scrollLeft).toBeLessThan(width);
      expect(286 + editor.state.currentTime * 82 * zoom - scroll.scrollLeft).toBeGreaterThan(
        width - 9 - frame * 82 * zoom,
      );
    }
    act(() =>
      window.dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 7, clientX: width + 400, ctrlKey }),
      ),
    );
    expect(286 + editor.state.currentTime * 82 * zoom - scroll.scrollLeft).toBeLessThan(width);
    expect(286 + editor.state.currentTime * 82 * zoom - scroll.scrollLeft).toBeGreaterThan(
      width - 9 - frame * 82 * zoom,
    );
  },
);

it("anchors Alt-wheel zoom to the pointer, pans with Shift, and leaves normal scrolling native", async () => {
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
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  expect((scroll.scrollLeft + 500 - 286) / (82 * timelineZoomStore.get())).toBeCloseTo(anchorTime);
  const previous = scroll.scrollLeft;
  expect(wheel({ shiftKey: true, deltaY: 3, deltaMode: 1 }).defaultPrevented).toBe(true);
  expect(scroll.scrollLeft).toBe(previous + 48);
  const zoom = timelineZoomStore.get();
  expect(wheel({}).defaultPrevented).toBe(false);
  expect(timelineZoomStore.get()).toBe(zoom);
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
  expect(timelineZoomStore.get()).toBe(1);
});
