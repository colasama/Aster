// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateAnimatable } from "../../core/animation/timeline";
import { applyOperations } from "../../core/editing/operations";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { I18nProvider } from "../../i18n/react";
import type { EditorAction } from "../../state/editor-store";
import { Viewport3dTransformControls } from "./Viewport3dTransformControls";

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

describe("Viewport3dTransformControls", () => {
  it("projects Local and World axis spaces differently at the evaluated rotation", () => {
    const project = createBlankProject(true);
    const composition = project.compositions[0];
    const layer = createLayerForComposition("solid", composition);
    layer.threeDimensional = true;
    layer.transform.rotation[2] = { mode: "static", value: 90 };
    composition.layers = [layer];
    const render = (space: "local" | "world") => (
      <I18nProvider>
        <Viewport3dTransformControls
          composition={composition}
          dispatch={vi.fn()}
          project={project}
          selection={[layer.id]}
          space={space}
          time={0}
          zoom={1}
        />
      </I18nProvider>
    );

    act(() => root.render(render("local")));
    const local = axisLine(container, "x");
    expect(Number(local.getAttribute("x2")) - Number(local.getAttribute("x1"))).toBeCloseTo(0, 4);
    expect(Number(local.getAttribute("y2")) - Number(local.getAttribute("y1"))).toBeGreaterThan(70);

    act(() => root.render(render("world")));
    const world = axisLine(container, "x");
    expect(Number(world.getAttribute("x2")) - Number(world.getAttribute("x1"))).toBeGreaterThan(70);
    expect(Number(world.getAttribute("y2")) - Number(world.getAttribute("y1"))).toBeCloseTo(0, 4);
  });

  it("writes an animated position keyframe at current time as one undoable gesture", () => {
    const project = createBlankProject(true);
    const composition = project.compositions[0];
    const layer = createLayerForComposition("shape", composition);
    layer.threeDimensional = true;
    layer.transform.position[0] = {
      mode: "animated",
      keyframes: [
        { id: "position-start", time: 0, value: 960, interpolation: "linear" },
        { id: "position-end", time: 2, value: 1160, interpolation: "linear" },
      ],
    };
    composition.layers = [layer];
    const dispatch = vi.fn<(action: EditorAction) => void>();
    act(() =>
      root.render(
        <I18nProvider>
          <Viewport3dTransformControls
            composition={composition}
            dispatch={dispatch}
            project={project}
            selection={[layer.id]}
            space="world"
            time={1}
            zoom={1}
          />
        </I18nProvider>,
      ),
    );
    const handle = container.querySelector<SVGElement>(
      ".viewport-gizmo-axis-x .viewport-gizmo-axis-handle",
    );
    expect(handle).not.toBeNull();
    if (!handle) return;

    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 0,
          clientY: 0,
          pointerId: 9,
        }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 36,
          clientY: 0,
          pointerId: 9,
        }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: 36,
          clientY: 0,
          pointerId: 9,
        }),
      );
    });

    const committed = dispatch.mock.calls
      .map(([action]) => action)
      .find((action) => action.type === "operation");
    expect(committed).toMatchObject({
      type: "operation",
      historyBase: project,
      operations: [
        {
          type: "addKeyframe",
          layerId: layer.id,
          path: "position.0",
          keyframe: { time: 1 },
        },
      ],
    });
    if (committed?.type !== "operation") return;
    const edited = applyOperations(project, committed.operations);
    const editedLayer = edited.compositions[0].layers[0];
    expect(editedLayer.transform.position[0].mode).toBe("animated");
    expect(evaluateAnimatable(editedLayer.transform.position[0], 1)).toBeCloseTo(1096, 3);
    const redone = applyOperations(committed.historyBase ?? project, committed.operations);
    expect(
      evaluateAnimatable(redone.compositions[0].layers[0].transform.position[0], 1),
    ).toBeCloseTo(1096, 3);
    expect(evaluateAnimatable(project.compositions[0].layers[0].transform.position[0], 1)).toBe(
      1060,
    );
  });

  it("shows locked 3D selection without exposing draggable surfaces or axes", () => {
    const project = createBlankProject(true);
    const composition = project.compositions[0];
    const layer = createLayerForComposition("solid", composition);
    layer.threeDimensional = true;
    layer.locked = true;
    composition.layers = [layer];
    act(() =>
      root.render(
        <I18nProvider>
          <Viewport3dTransformControls
            composition={composition}
            dispatch={vi.fn()}
            project={project}
            selection={[layer.id]}
            space="local"
            time={0}
            zoom={1}
          />
        </I18nProvider>,
      ),
    );

    expect(container.querySelector(".viewport-selection-outline-3d.locked")).not.toBeNull();
    expect(container.querySelector(".viewport-selection-hit-3d")).toBeNull();
    expect(container.querySelector(".viewport-gizmo-axis-handle")).toBeNull();
  });
});

function axisLine(container: HTMLElement, axis: "x" | "y" | "z"): SVGLineElement {
  const line = container.querySelector<SVGLineElement>(
    `.viewport-gizmo-axis-${axis} .viewport-gizmo-axis-line`,
  );
  if (!line) throw new Error(`Expected ${axis} axis`);
  return line;
}
