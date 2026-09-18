// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { evaluateAnimatable, evaluateEffectParameter } from "../../core/animation/timeline";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { activeComposition, createBlankProject } from "../../core/project/project";
import type { Project } from "../../core/types";
import { createEffect } from "../../effects/registry";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, useEditor } from "../../state/editor-store";
import { Inspector } from "./Inspector";

let root: Root;
let editor: ReturnType<typeof useEditor>;
let frame: FrameRequestCallback | undefined;
function Observe({ project }: { project: Project }) {
  const currentEditor = useEditor();
  editor = currentEditor;
  const { dispatch } = currentEditor;
  useEffect(() => {
    dispatch({ type: "loadProject", project });
    dispatch({ type: "setTime", time: 1 });
  }, [dispatch, project]);
  return null;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    frame = undefined;
  });
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
  frame = undefined;
});
function mount({ animated = false, locked = false } = {}) {
  const project = createBlankProject(true);
  const composition = activeComposition(project);
  const layer = createLayerForComposition("solid", composition);
  layer.locked = locked;
  layer.transform.position[0] = animated
    ? {
        mode: "animated",
        keyframes: [
          { id: "a", time: 0, value: 0, interpolation: "linear" },
          { id: "b", time: 2, value: 100, interpolation: "linear" },
        ],
      }
    : { mode: "static", value: 50 };
  const effect = createEffect("glow");
  if (animated)
    effect.parameterKeyframes = {
      intensity: [
        { id: "ea", time: 0, value: 0, interpolation: "linear" },
        { id: "eb", time: 2, value: 2, interpolation: "linear" },
      ],
    };
  layer.effects = [effect];
  composition.layers = [layer];
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <EditorProvider>
          <Observe project={project} />
          <Inspector />
        </EditorProvider>
      </I18nProvider>,
    ),
  );
  return container;
}
function field(label = "Position X", type = "number") {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"][type="${type}"]`,
  );
  if (!input) throw new Error(`Missing ${label}`);
  return input;
}
function pointer(target: EventTarget, type: string, clientX: number, extra = {}) {
  act(() =>
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX, ...extra }),
    ),
  );
}
function flush() {
  const callback = frame;
  frame = undefined;
  act(() => callback?.(0));
}
function key(target: EventTarget, name: string, extra = {}) {
  act(() =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...extra })),
  );
}
function typeValue(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function position() {
  return activeComposition(editor.state.project).layers[0].transform.position[0];
}

it("previews at most once per frame and commits an animated scrub as one undo step", () => {
  mount({ animated: true });
  pointer(field(), "pointerdown", 100);
  pointer(window, "pointermove", 110);
  pointer(window, "pointermove", 120);
  expect(evaluateAnimatable(position(), 1)).toBe(50);
  flush();
  expect(evaluateAnimatable(position(), 1)).toBe(70);
  expect(editor.state.history.past).toHaveLength(0);
  pointer(window, "pointermove", 130);
  flush();
  pointer(window, "pointerup", 130);
  expect(editor.state.history.past).toHaveLength(1);
  expect(evaluateAnimatable(position(), 1)).toBe(80);
  act(() => editor.dispatch({ type: "undo" }));
  expect(position()).toEqual(
    expect.objectContaining({
      keyframes: expect.arrayContaining([
        expect.objectContaining({ id: "a" }),
        expect.objectContaining({ id: "b" }),
      ]),
    }),
  );
  expect(evaluateAnimatable(position(), 1)).toBe(50);
  act(() => editor.dispatch({ type: "redo" }));
  expect(evaluateAnimatable(position(), 1)).toBe(80);
});

it.each(["Escape", "pointercancel", "blur"])(
  "restores an animated track on %s without recording history",
  (reason) => {
    mount({ animated: true });
    const original = position();
    pointer(field(), "pointerdown", 100);
    pointer(window, "pointermove", 120);
    flush();
    pointer(window, "pointermove", 140);
    flush();
    if (reason === "Escape") key(window, reason);
    else if (reason === "blur") act(() => window.dispatchEvent(new Event("blur")));
    else pointer(window, reason, 140);
    expect(position()).toEqual(original);
    expect(editor.state.history.past).toHaveLength(0);
  },
);

it("applies modifier changes incrementally and reverses immediately at a bound", () => {
  mount();
  const input = field("Opacity");
  pointer(input, "pointerdown", 100);
  pointer(window, "pointermove", 120);
  flush();
  expect(input.value).toBe("100");
  pointer(window, "pointermove", 110, { altKey: true });
  flush();
  expect(input.value).toBe("99");
  pointer(window, "pointermove", 109, { shiftKey: true });
  pointer(window, "pointerup", 109);
  expect(input.value).toBe("89");
  expect(editor.state.history.past).toHaveLength(1);
});

it("keeps empty and partial edits local, commits once on Enter, and clamps pasted values", () => {
  mount();
  const input = field();
  act(() => input.focus());
  typeValue(input, "");
  expect(evaluateAnimatable(position(), 1)).toBe(50);
  typeValue(input, "-12.5");
  key(input, "Enter");
  expect(evaluateAnimatable(position(), 1)).toBe(-12.5);
  expect(editor.state.history.past).toHaveLength(1);
  typeValue(input, "99");
  key(input, "Escape");
  expect(input.value).toBe("-12.5");
  typeValue(field("Opacity"), "999");
  key(field("Opacity"), "Enter");
  expect(field("Opacity").value).toBe("100");
});

it("groups slider changes and cancels animated effect scrubs without leaving inserted keyframes", () => {
  mount({ animated: true });
  const slider = field("Opacity", "range");
  pointer(slider, "pointerdown", 100);
  typeValue(slider, "75");
  flush();
  typeValue(slider, "65");
  flush();
  pointer(window, "pointerup", 110);
  expect(editor.state.history.past).toHaveLength(1);
  act(() => editor.dispatch({ type: "undo" }));
  expect(field("Opacity").value).toBe("100");
  const effectInput = field("Glow Intensity");
  const original = activeComposition(editor.state.project).layers[0].effects[0];
  pointer(effectInput, "pointerdown", 100);
  pointer(window, "pointermove", 110);
  flush();
  pointer(window, "pointermove", 120);
  flush();
  key(window, "Escape");
  const restored = activeComposition(editor.state.project).layers[0].effects[0];
  expect(restored.parameterKeyframes).toEqual(original.parameterKeyframes);
  expect(evaluateEffectParameter(restored, "intensity", 1)).toBe(1);
  expect(editor.state.history.past).toHaveLength(0);
  expect(editor.state.history.future).toHaveLength(1);
});

it("disables locked transforms", () => {
  mount({ locked: true });
  expect(field().disabled).toBe(true);
  pointer(field(), "pointerdown", 100);
  pointer(window, "pointermove", 140);
  flush();
  pointer(window, "pointerup", 140);
  expect(evaluateAnimatable(position(), 1)).toBe(50);
  expect(editor.state.history.past).toHaveLength(0);
});

it("cancels a scrub when seeking and preserves exact values on a click without edits", () => {
  mount({ animated: true });
  const original = position();
  pointer(field(), "pointerdown", 100);
  pointer(window, "pointermove", 120);
  flush();
  act(() => editor.dispatch({ type: "setTime", time: 1.5 }));
  pointer(window, "pointerup", 120);
  expect(position()).toEqual(original);
  expect(editor.state.history.past).toHaveLength(0);
  act(() =>
    editor.dispatch({
      type: "operation",
      operations: [
        {
          type: "setProperty",
          layerId: activeComposition(editor.state.project).layers[0].id,
          path: "position.0",
          value: 1.23456789,
        },
      ],
    }),
  );
  const exact = position();
  pointer(field(), "pointerdown", 100);
  pointer(window, "pointermove", 101);
  pointer(window, "pointerup", 101);
  act(() => field().blur());
  expect(position()).toEqual(exact);
  expect(editor.state.history.past).toHaveLength(1);
});
