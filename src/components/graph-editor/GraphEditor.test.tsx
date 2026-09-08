// @vitest-environment happy-dom

import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeComposition, createDemoProject } from "../../core/project/project";
import type { Project } from "../../core/types";
import { createEffect } from "../../effects/registry";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, type EditorState, useEditor } from "../../state/editor-store";
import { GraphEditor } from "./GraphEditor";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function GraphHarness({
  project,
  capture,
  selection,
}: {
  project: Project;
  capture: (state: EditorState) => void;
  selection?: string[];
}) {
  const { state, dispatch } = useEditor();
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    dispatch({ type: "loadProject", project });
    if (selection) dispatch({ type: "select", ids: selection });
  }, [dispatch, project, selection]);
  useEffect(() => {
    capture(state);
  }, [capture, state]);
  return <GraphEditor />;
}

describe("GraphEditor", () => {
  it("renders registry effect metadata and keyboard-edits it as one stable-ID transaction", () => {
    const project = createDemoProject();
    const layer = activeComposition(project).layers[0];
    const effect = createEffect("gaussian-blur");
    effect.parameterKeyframes = {
      radius: [
        { id: "radius-start", time: 0, value: 18, interpolation: "linear" },
        { id: "radius-end", time: 1, value: 42, interpolation: "linear" },
      ],
    };
    layer.effects.push(effect);
    let latest: EditorState | undefined;

    act(() =>
      root.render(
        <I18nProvider>
          <EditorProvider>
            <GraphHarness capture={(state) => (latest = state)} project={project} />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const effectTrackButton = [...container.querySelectorAll(".graph-track-list button")].find(
      (button) => button.textContent?.includes("Gaussian Blur · Blurriness"),
    );
    expect(effectTrackButton?.textContent).toContain("VALUE · px");
    const marker = [...container.querySelectorAll<SVGEllipseElement>(".graph-key")].find((entry) =>
      entry.getAttribute("aria-label")?.startsWith("Gaussian Blur · Blurriness keyframe"),
    );
    expect(marker).toBeDefined();
    act(() => marker?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
    expect(latest?.selectedKeyframes).toEqual(["radius-start"]);
    act(() =>
      marker?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })),
    );

    const updatedEffect =
      latest &&
      activeComposition(latest.project).layers[0].effects.find(
        (candidate) => candidate.id === effect.id,
      );
    expect(updatedEffect?.parameterKeyframes?.radius?.[0]).toMatchObject({
      id: "radius-start",
      value: 18.5,
    });
    expect(latest?.history.past).toHaveLength(1);
  });

  it("namespaces identical paths across selected layers and routes edits around locked owners", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const first = composition.layers[0];
    const second = createLayerForComposition("shape", composition);
    first.name = "Locked Logo";
    second.name = "Editable Logo";
    first.locked = true;
    first.transform.opacity = {
      mode: "animated",
      keyframes: [{ id: "same-key", time: 0, value: 50, interpolation: "linear" }],
    };
    second.transform.opacity = {
      mode: "animated",
      keyframes: [{ id: "same-key", time: 0, value: 25, interpolation: "linear" }],
    };
    composition.layers.push(second);
    let latest: EditorState | undefined;

    act(() =>
      root.render(
        <I18nProvider>
          <EditorProvider>
            <GraphHarness
              capture={(state) => (latest = state)}
              project={project}
              selection={[first.id, second.id]}
            />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const markers = [...container.querySelectorAll<SVGEllipseElement>(".graph-key")];
    const locked = markers.find((entry) =>
      entry.getAttribute("aria-label")?.startsWith("Locked Logo · Opacity keyframe"),
    );
    const editable = markers.find((entry) =>
      entry.getAttribute("aria-label")?.startsWith("Editable Logo · Opacity keyframe"),
    );
    expect(locked).toBeDefined();
    expect(editable).toBeDefined();
    act(() =>
      locked?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })),
    );
    expect(latest?.history.past).toHaveLength(0);
    act(() =>
      editable?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })),
    );
    expect(container.querySelectorAll(".graph-key.selected")).toHaveLength(1);
    expect(container.querySelector(".graph-key.selected")?.getAttribute("aria-label")).toContain(
      "Editable Logo · Opacity",
    );
    act(() =>
      editable?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })),
    );

    const layers = latest && activeComposition(latest.project).layers;
    expect(layers?.find((layer) => layer.id === first.id)?.transform.opacity).toMatchObject({
      keyframes: [{ id: "same-key", value: 50 }],
    });
    expect(layers?.find((layer) => layer.id === second.id)?.transform.opacity).toMatchObject({
      keyframes: [{ id: "same-key", value: 26 }],
    });
    expect(latest?.history.past).toHaveLength(1);
  });

  it("quantizes keyboard edits on choice tracks and forces Hold interpolation", () => {
    const project = createDemoProject();
    const layer = activeComposition(project).layers[0];
    const effect = createEffect("radial-blur");
    effect.parameterKeyframes = {
      mode: [
        { id: "mode-start", time: 0, value: 0, interpolation: "bezier" },
        { id: "mode-end", time: 1, value: 1, interpolation: "bezier" },
      ],
    };
    layer.effects.push(effect);
    let latest: EditorState | undefined;

    act(() =>
      root.render(
        <I18nProvider>
          <EditorProvider>
            <GraphHarness capture={(state) => (latest = state)} project={project} />
          </EditorProvider>
        </I18nProvider>,
      ),
    );
    const marker = [...container.querySelectorAll<SVGEllipseElement>(".graph-key")].find((entry) =>
      entry.getAttribute("aria-label")?.startsWith("Radial Blur · Type keyframe at 0.000"),
    );
    expect(marker).toBeDefined();
    act(() =>
      marker?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })),
    );

    expect(
      latest &&
        activeComposition(latest.project).layers[0].effects.find(
          (candidate) => candidate.id === effect.id,
        )?.parameterKeyframes?.mode?.[0],
    ).toMatchObject({ id: "mode-start", value: 1, interpolation: "step", easing: undefined });
    expect(latest?.history.past).toHaveLength(1);
  });
});

import { createLayerForComposition } from "../../core/layers/layer-factory";
