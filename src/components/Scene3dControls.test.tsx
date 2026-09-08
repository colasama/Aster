// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { activeComposition, createBlankProject } from "../core/project";
import { evaluateAnimatable } from "../core/timeline";
import type { Layer, Project } from "../core/types";
import { I18nProvider } from "../i18n/react";
import { EditorProvider, useEditor } from "../state/editor-store";
import { Scene3dControls } from "./Scene3dControls";

let root: Root | undefined;
let latestEditor: ReturnType<typeof useEditor> | undefined;

function LoadProject({ project, time }: { project: Project; time?: number }) {
  const { dispatch } = useEditor();
  useEffect(() => {
    dispatch({ type: "loadProject", project });
    if (time !== undefined) dispatch({ type: "setTime", time });
  }, [dispatch, project, time]);
  return null;
}

function SelectedCameraControls() {
  const editor = useEditor();
  latestEditor = editor;
  const layer = activeComposition(editor.state.project).layers.find(
    (candidate) => candidate.kind === "camera",
  );
  return layer ? <Scene3dControls layer={layer} /> : null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  latestEditor = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("camera options controls", () => {
  it("uses the canonical orthographic size bounds", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const project = createBlankProject();
    const composition = project.compositions[0];
    const camera = createLayerForComposition("camera", composition);
    if (!camera.camera) throw new Error("Expected camera settings");
    camera.camera.projection = "orthographic";
    composition.layers = [camera];
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={project} />
            <SelectedCameraControls />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const size = input(container, "Orthographic size");
    expect(size.max).toBe("10000000");
    change(size, "10000000");
    const edited = activeComposition(latestEditor?.state.project ?? project).layers[0].camera;
    expect(edited?.orthographicSize).toEqual({ mode: "static", value: 10_000_000 });
  });

  it("edits vector and optical animation at current time without collapsing tracks", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const project = createBlankProject();
    const composition = project.compositions[0];
    const camera = createLayerForComposition("camera", composition);
    if (!camera.camera) throw new Error("Expected camera settings");
    camera.camera.depthOfField = true;
    camera.camera.pointOfInterest[0] = animated(900, 1100);
    camera.camera.orientation[2] = animated(0, 90);
    camera.camera.zoom = animated(1000, 3000);
    camera.camera.focusDistance = animated(1000, 2000);
    composition.layers = [camera];
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={project} time={1} />
            <SelectedCameraControls />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    change(input(container, "Point of interest X"), "1050");
    change(input(container, "Orientation Z"), "60");
    change(input(container, "Zoom"), "2400");
    change(input(container, "Focus distance"), "1600");

    let edited = activeComposition(latestEditor?.state.project ?? project).layers[0].camera;
    if (!edited) throw new Error("Expected edited camera settings");
    expectAnimatedValue(edited.pointOfInterest[0], 1050);
    expectAnimatedValue(edited.orientation[2], 60);
    expectAnimatedValue(edited.zoom, 2400);
    expectAnimatedValue(edited.focusDistance, 1600);
    expect(edited.lockFocusToZoom).toBe(false);

    act(() => latestEditor?.dispatch({ type: "undo" }));
    edited = activeComposition(latestEditor?.state.project ?? project).layers[0].camera;
    if (!edited) throw new Error("Expected undone camera settings");
    expect(
      edited.focusDistance.mode === "animated" ? edited.focusDistance.keyframes : [],
    ).toHaveLength(2);
    expect(evaluateAnimatable(edited.focusDistance, 1)).toBe(1500);
    expectAnimatedValue(edited.zoom, 2400);

    act(() => latestEditor?.dispatch({ type: "redo" }));
    edited = activeComposition(latestEditor?.state.project ?? project).layers[0].camera;
    if (!edited) throw new Error("Expected redone camera settings");
    expectAnimatedValue(edited.focusDistance, 1600);
  });

  it("exposes bounded iris, diffraction, and highlight controls", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const project = createBlankProject();
    const composition = project.compositions[0];
    const camera = createLayerForComposition("camera", composition);
    if (!camera.camera) throw new Error("Expected camera settings");
    camera.camera.depthOfField = true;
    composition.layers.push(camera);
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={project} />
            <Scene3dControls layer={camera as Layer} />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const iris = container.querySelector<HTMLSelectElement>('select[aria-label="Iris shape"]');
    expect(iris?.options).toHaveLength(10);
    expect(iris?.value).toBe("fastRectangle");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Iris roundness"]')?.max,
    ).toBe("100");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Iris aspect ratio"]')?.min,
    ).toBe("1");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Diffraction fringe"]'),
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Highlight gain"]'),
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Highlight threshold"]')?.max,
    ).toBe("1");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Highlight saturation"]'),
    ).not.toBeNull();
  });
});

function animated(start: number, end: number) {
  return {
    mode: "animated" as const,
    keyframes: [
      { id: `start-${start}`, time: 0, value: start, interpolation: "linear" as const },
      { id: `end-${end}`, time: 2, value: end, interpolation: "linear" as const },
    ],
  };
}

function input(container: ParentNode, label: string): HTMLInputElement {
  const result = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!result) throw new Error(`Expected ${label} control`);
  return result;
}

function change(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function expectAnimatedValue(property: Layer["transform"]["opacity"], value: number): void {
  expect(property.mode).toBe("animated");
  expect(property.mode === "animated" ? property.keyframes : []).toHaveLength(3);
  expect(evaluateAnimatable(property, 1)).toBe(value);
}
