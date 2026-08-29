// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import type { Layer, Project } from "../core/types";
import { I18nProvider } from "../i18n/react";
import { EditorProvider, useEditor } from "../state/editor-store";
import { Scene3dControls } from "./Scene3dControls";

let root: Root | undefined;

function LoadProject({ project }: { project: Project }) {
  const { dispatch } = useEditor();
  useEffect(() => dispatch({ type: "loadProject", project }), [dispatch, project]);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("AE camera options controls", () => {
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
