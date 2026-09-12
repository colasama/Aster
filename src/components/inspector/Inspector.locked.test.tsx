// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { activeComposition, createDemoProject } from "../../core/project/project";
import type { Project } from "../../core/types";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, useEditor } from "../../state/editor-store";
import { Inspector } from "./Inspector";

let root: Root | undefined;

function LoadProject({ project }: { project: Project }) {
  const { dispatch } = useEditor();
  useEffect(() => dispatch({ type: "loadProject", project }), [dispatch, project]);
  return null;
}

function lockedSpecializedProject(kind: "audio" | "camera" | "solid" | "text"): Project {
  const project = createDemoProject();
  const composition = activeComposition(project);
  const layer = createLayerForComposition(kind, composition);
  layer.locked = true;
  composition.layers = [layer];
  return project;
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

describe("locked layer inspector", () => {
  it.each([
    ["audio", 'input[aria-label="Pan"]'],
    ["solid", 'input[aria-label="Solid width"]'],
    ["text", 'textarea[aria-label="Text content"]'],
    ["camera", 'select[aria-label="Camera projection"]'],
  ] as const)("disables %s-specific mutation controls", (kind, selector) => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={lockedSpecializedProject(kind)} />
            <Inspector />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    expect(container.querySelector<HTMLDetailsElement>(".layer-content-section")?.open).toBe(true);
    const mutationBoundary = container.querySelector<HTMLFieldSetElement>(
      "fieldset.compositing-grid",
    );
    const control = container.querySelector<HTMLElement>(selector);
    expect(mutationBoundary?.disabled).toBe(true);
    expect(control).not.toBeNull();
    expect(control?.closest<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
    expect(container.querySelector<HTMLFieldSetElement>("fieldset.effects-section")?.disabled).toBe(
      true,
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Unlock layer"]')?.disabled,
    ).toBe(false);
  });
});
