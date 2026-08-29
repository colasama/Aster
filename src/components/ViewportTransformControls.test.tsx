// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeComposition, createDemoProject } from "../core/project";
import { I18nProvider } from "../i18n/react";
import type { EditorAction } from "../state/editor-store";
import { ViewportTransformControls } from "./ViewportTransformControls";

let container: HTMLDivElement;
let root: Root;
const capturedPointers = new WeakMap<SVGElement, Set<number>>();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  Object.defineProperties(SVGElement.prototype, {
    hasPointerCapture: {
      configurable: true,
      value(this: SVGElement, pointerId: number) {
        return capturedPointers.get(this)?.has(pointerId) ?? false;
      },
    },
    releasePointerCapture: {
      configurable: true,
      value(this: SVGElement, pointerId: number) {
        capturedPointers.get(this)?.delete(pointerId);
      },
    },
    setPointerCapture: {
      configurable: true,
      value(this: SVGElement, pointerId: number) {
        const pointers = capturedPointers.get(this) ?? new Set<number>();
        pointers.add(pointerId);
        capturedPointers.set(this, pointers);
      },
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("ViewportTransformControls", () => {
  it("renders exact eight-handle controls and dispatches one keyboard transaction", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const layer = composition.layers.find(
      (candidate) => candidate.kind === "shape" && !candidate.threeDimensional,
    );
    expect(layer).toBeDefined();
    if (!layer) return;
    const dispatch = vi.fn<(action: EditorAction) => void>();
    act(() =>
      root.render(
        <I18nProvider>
          <ViewportTransformControls
            activeTool="select"
            composition={composition}
            dispatch={dispatch}
            onEditText={vi.fn()}
            project={project}
            selection={[layer.id]}
            showGuides
            time={0}
            zoom={0.5}
          />
        </I18nProvider>,
      ),
    );

    expect(container.querySelectorAll(".viewport-resize-handle")).toHaveLength(8);
    expect(container.querySelector(".viewport-anchor-handle")).not.toBeNull();
    const hit = container.querySelector<SVGElement>(".viewport-selection-hit");
    act(() =>
      hit?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "operation",
      operations: [{ type: "setProperty", layerId: layer.id, path: "position.0" }],
    });
  });

  it("protects locked and invisible layers from direct manipulation", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const layer = composition.layers.find(
      (candidate) => candidate.kind === "text" && !candidate.threeDimensional,
    );
    expect(layer).toBeDefined();
    if (!layer) return;
    layer.locked = true;
    const render = () => (
      <I18nProvider>
        <ViewportTransformControls
          activeTool="select"
          composition={composition}
          dispatch={vi.fn()}
          onEditText={vi.fn()}
          project={project}
          selection={[layer.id]}
          showGuides={false}
          time={0}
          zoom={1}
        />
      </I18nProvider>
    );
    act(() => root.render(render()));
    expect(container.querySelector(".viewport-selection-outline.locked")).not.toBeNull();
    expect(container.querySelectorAll(".viewport-resize-handle")).toHaveLength(0);

    layer.visible = false;
    act(() => root.render(render()));
    expect(container.querySelector(".viewport-transform-controls")).toBeNull();
  });

  it.each<[string, (target: SVGElement, pointerId: number) => void]>([
    [
      "Escape",
      () => window.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, key: "Escape" })),
    ],
    ["window blur", () => window.dispatchEvent(new Event("blur"))],
    [
      "pointer cancellation",
      (target: SVGElement, pointerId: number) =>
        target.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId })),
    ],
    [
      "pointer capture loss",
      (target: SVGElement, pointerId: number) =>
        target.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId })),
    ],
  ])("cancels an active gesture on %s without committing history", (_label, cancel) => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const layer = composition.layers.find(
      (candidate) => candidate.kind === "shape" && !candidate.threeDimensional,
    );
    expect(layer).toBeDefined();
    if (!layer) return;
    const dispatch = vi.fn<(action: EditorAction) => void>();
    act(() =>
      root.render(
        <I18nProvider>
          <ViewportTransformControls
            activeTool="select"
            composition={composition}
            dispatch={dispatch}
            onEditText={vi.fn()}
            project={project}
            selection={[layer.id]}
            showGuides={false}
            time={0}
            zoom={1}
          />
        </I18nProvider>,
      ),
    );
    const target = container.querySelector<SVGElement>(".viewport-selection-hit");
    expect(target).not.toBeNull();
    if (!target) return;
    const pointerId = 7;
    act(() => {
      target.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          clientY: 100,
          pointerId,
        }),
      );
      target.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 140,
          clientY: 120,
          pointerId,
        }),
      );
    });
    expect(
      dispatch.mock.calls.filter(([action]) => action.type === "previewOperation"),
    ).toHaveLength(1);
    act(() => cancel(target, pointerId));
    expect(
      dispatch.mock.calls.filter(([action]) => action.type === "previewOperation"),
    ).toHaveLength(2);
    expect(dispatch.mock.calls.some(([action]) => action.type === "operation")).toBe(false);
    act(() =>
      target.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 140, clientY: 120, pointerId }),
      ),
    );
    expect(dispatch.mock.calls.some(([action]) => action.type === "operation")).toBe(false);
  });
});
