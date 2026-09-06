// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { activeComposition, createBlankProject, createDemoProject } from "../core/project";
import { evaluateAnimatable } from "../core/timeline";
import type { Project } from "../core/types";
import { createEffect } from "../effects/registry";
import { diagnosticStore } from "../errors/diagnostic-store";
import { I18nProvider } from "../i18n/react";
import { EditorProvider, useEditor } from "../state/editor-store";
import { Inspector } from "./Inspector";

let root: Root | undefined;
let latestEditor: ReturnType<typeof useEditor> | undefined;

function LoadProject({ project, time }: { project: Project; time?: number }) {
  const editor = useEditor();
  const { dispatch } = editor;
  latestEditor = editor;
  useEffect(() => {
    dispatch({ type: "loadProject", project });
    if (time !== undefined) dispatch({ type: "setTime", time });
  }, [dispatch, project, time]);
  return null;
}

function adjustmentProject(): Project {
  const project = createDemoProject();
  const composition = activeComposition(project);
  composition.layers = [createLayerForComposition("adjustment", composition)];
  return project;
}

function clearDiagnostics() {
  for (const diagnostic of diagnosticStore.snapshot()) diagnosticStore.resolve(diagnostic.id);
  diagnosticStore.clearInactive();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
  clearDiagnostics();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  latestEditor = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
  clearDiagnostics();
  vi.restoreAllMocks();
});

describe("time-addressed inspector property edits", () => {
  it("edits Anchor Point as an animated Transform property with undo and redo", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const project = createBlankProject();
    const composition = activeComposition(project);
    const layer = createLayerForComposition("text", composition);
    layer.transform.anchor[0] = {
      mode: "animated",
      keyframes: [
        { id: "anchor-start", time: 0, value: 400, interpolation: "linear" },
        { id: "anchor-end", time: 2, value: 800, interpolation: "linear" },
      ],
    };
    composition.layers = [layer];
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={project} time={1} />
            <Inspector />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const anchorX = container.querySelector<HTMLInputElement>('input[aria-label="Anchor Point X"]');
    if (!anchorX) throw new Error("Expected Anchor Point X control");
    change(anchorX, "650");

    let edited = activeComposition(latestEditor?.state.project ?? project).layers[0].transform
      .anchor[0];
    expect(edited.mode).toBe("animated");
    if (edited.mode !== "animated") throw new Error("Expected animated Anchor Point X");
    expect(edited.keyframes).toHaveLength(3);
    expect(evaluateAnimatable(edited, 1)).toBe(650);

    act(() => latestEditor?.dispatch({ type: "undo" }));
    edited = activeComposition(latestEditor?.state.project ?? project).layers[0].transform
      .anchor[0];
    expect(edited.mode === "animated" ? edited.keyframes : []).toHaveLength(2);
    expect(evaluateAnimatable(edited, 1)).toBe(600);

    act(() => latestEditor?.dispatch({ type: "redo" }));
    edited = activeComposition(latestEditor?.state.project ?? project).layers[0].transform
      .anchor[0];
    expect(edited.mode === "animated" ? edited.keyframes : []).toHaveLength(3);
    expect(evaluateAnimatable(edited, 1)).toBe(650);
  });

  it("resets Anchor Point to the rendered source center", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const project = createBlankProject();
    const composition = activeComposition(project);
    const layer = createLayerForComposition("shape", composition);
    layer.size = [640, 360];
    layer.transform.anchor = [
      { mode: "static", value: 10 },
      { mode: "static", value: 20 },
      { mode: "static", value: 30 },
    ];
    composition.layers = [layer];
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={project} />
            <Inspector />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Reset transform"]')?.click(),
    );

    const resetLayer = activeComposition(latestEditor?.state.project ?? project).layers[0];
    expect(resetLayer.transform.anchor.map((property) => evaluateAnimatable(property, 0))).toEqual([
      320, 180, 0,
    ]);
  });

  it("inserts an animated transform keyframe at current time and supports undo and redo", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const project = createBlankProject();
    const composition = activeComposition(project);
    const layer = createLayerForComposition("solid", composition);
    layer.transform.position[0] = {
      mode: "animated",
      keyframes: [
        { id: "start", time: 0, value: 100, interpolation: "linear" },
        {
          id: "end",
          time: 2,
          value: 300,
          interpolation: "bezier",
          easing: [0.2, 0.1, 0.8, 0.9],
          spatialIn: -20,
        },
      ],
    };
    const originalAtOne = evaluateAnimatable(layer.transform.position[0], 1);
    composition.layers = [layer];
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={project} time={1} />
            <Inspector />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const positionX = container.querySelector<HTMLInputElement>('input[aria-label="Position X"]');
    if (!positionX) throw new Error("Expected Position X control");
    change(positionX, "240");

    let edited = activeComposition(latestEditor?.state.project ?? project).layers[0].transform
      .position[0];
    expect(edited.mode).toBe("animated");
    if (edited.mode !== "animated") throw new Error("Expected animated Position X");
    expect(edited.keyframes).toHaveLength(3);
    expect(evaluateAnimatable(edited, 1)).toBe(240);
    expect(edited.keyframes.map(({ id, time, value }) => ({ id, time, value }))).toEqual([
      { id: "start", time: 0, value: 100 },
      expect.objectContaining({ time: 1, value: 240 }),
      { id: "end", time: 2, value: 300 },
    ]);

    act(() => latestEditor?.dispatch({ type: "undo" }));
    const undone = activeComposition(latestEditor?.state.project ?? project).layers[0].transform
      .position[0];
    expect(undone.mode === "animated" ? undone.keyframes : []).toHaveLength(2);
    expect(evaluateAnimatable(undone, 1)).toBe(originalAtOne);

    act(() => latestEditor?.dispatch({ type: "redo" }));
    edited = activeComposition(latestEditor?.state.project ?? project).layers[0].transform
      .position[0];
    expect(edited.mode === "animated" ? edited.keyframes : []).toHaveLength(3);
    expect(evaluateAnimatable(edited, 1)).toBe(240);
  });

  it("keeps a static transform property static", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const project = createBlankProject();
    const composition = activeComposition(project);
    const layer = createLayerForComposition("solid", composition);
    composition.layers = [layer];
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={project} time={1.25} />
            <Inspector />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const positionX = container.querySelector<HTMLInputElement>('input[aria-label="Position X"]');
    if (!positionX) throw new Error("Expected Position X control");
    change(positionX, "420");
    expect(
      activeComposition(latestEditor?.state.project ?? project).layers[0].transform.position[0],
    ).toEqual({ mode: "static", value: 420 });
  });
});

describe("adjustment layer inspector", () => {
  it("exposes only safe layer switches, effects, and in/out timing", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const project = adjustmentProject();
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={project} />
            <Inspector />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    expect(
      [...container.querySelectorAll(".panel-tabs button")].map((button) => button.textContent),
    ).toEqual(["AI Assistant", "Properties"]);
    expect(container.textContent).toContain("Effects");
    expect(container.textContent).not.toContain("Transform");
    expect(container.textContent).not.toContain("Opacity");
    expect(container.textContent).not.toContain("Parent");
    expect(container.textContent).not.toContain("Source offset");
    expect(container.textContent).not.toContain("Time stretch");
    expect(container.textContent).not.toContain("Enable time remapping");
    expect(container.textContent).not.toContain("Enable 3D layer");
    expect(container.querySelector('button[aria-label="Hide layer"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Solo layer"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Lock layer"]')).not.toBeNull();

    const timingButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Layer timing"),
    );
    act(() => timingButton?.click());
    expect(container.textContent).toContain("In point");
    expect(container.textContent).toContain("Out point");
  });

  it("reports the concrete LUT parse failure with layer and property scope", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const project = adjustmentProject();
    const layer = activeComposition(project).layers[0];
    if (!layer) throw new Error("Expected adjustment layer");
    const lut = createEffect("lut");
    layer.effects = [lut];
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={project} />
            <Inspector />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const picker = container.querySelector<HTMLInputElement>('input[accept=".cube,text/plain"]');
    if (!picker) throw new Error("Expected LUT picker");
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [new File([], "broken.cube", { type: "text/plain" })],
    });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(diagnosticStore.snapshot()).toHaveLength(1);
    expect(diagnosticStore.snapshot()[0]).toMatchObject({
      code: "ui_lut_import_failed",
      message: "LUT_3D_SIZE is required",
      scope: {
        area: "property",
        layerId: layer.id,
        propertyPath: `effects.${lut.id}.lut`,
      },
      details: { message: "LUT_3D_SIZE is required" },
    });
  });
});

function change(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
