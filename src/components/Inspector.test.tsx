// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { activeComposition, createDemoProject } from "../core/project";
import type { Project } from "../core/types";
import { createEffect } from "../effects/registry";
import { diagnosticStore } from "../errors/diagnostic-store";
import { I18nProvider } from "../i18n/react";
import { EditorProvider, useEditor } from "../state/editor-store";
import { Inspector } from "./Inspector";

let root: Root | undefined;

function LoadProject({ project }: { project: Project }) {
  const { dispatch } = useEditor();
  useEffect(() => dispatch({ type: "loadProject", project }), [dispatch, project]);
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
  document.body.replaceChildren();
  window.localStorage.clear();
  clearDiagnostics();
  vi.restoreAllMocks();
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
