// @vitest-environment happy-dom

import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { activeComposition, createDemoProject } from "../core/project";
import type { Project } from "../core/types";
import { I18nProvider } from "../i18n/react";
import { EditorProvider, type EditorState, useEditor } from "../state/editor-store";
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

function Harness({
  project,
  capture,
  selection,
}: {
  project: Project;
  capture: (state: EditorState) => void;
  selection: string[];
}) {
  const { state, dispatch } = useEditor();
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    dispatch({ type: "loadProject", project });
    dispatch({ type: "select", ids: selection });
  }, [dispatch, project, selection]);
  useEffect(() => {
    capture(state);
  }, [capture, state]);
  return <GraphEditor />;
}

describe("GraphEditor text animator tracks", () => {
  it("discovers a Range End key and keyboard-edits it in one history transaction", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const layer = createLayerForComposition("text", composition);
    const animator = layer.textAnimator?.groups[0];
    const selector = animator?.selectors[0];
    if (!animator || !selector || selector.kind !== "range")
      throw new Error("Expected range text animator");
    animator.name = "Reveal";
    selector.name = "Characters";
    selector.end = {
      mode: "animated",
      keyframes: [
        { id: "range-end-start", time: 0, value: 0, interpolation: "linear" },
        { id: "range-end-finish", time: 1, value: 100, interpolation: "linear" },
      ],
    };
    composition.layers.push(layer);
    let latest: EditorState | undefined;

    act(() =>
      root.render(
        <I18nProvider>
          <EditorProvider>
            <Harness
              capture={(state) => (latest = state)}
              project={project}
              selection={[layer.id]}
            />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const track = [...container.querySelectorAll(".graph-track-list button")].find((button) =>
      button.textContent?.includes("Reveal · Characters · End"),
    );
    expect(track?.textContent).toContain("VALUE · %");
    const marker = [...container.querySelectorAll<SVGEllipseElement>(".graph-key")].find((entry) =>
      entry.getAttribute("aria-label")?.startsWith("Reveal · Characters · End keyframe at 0.000"),
    );
    expect(marker).toBeDefined();
    act(() => marker?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
    act(() =>
      marker?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })),
    );

    const editedLayer =
      latest &&
      activeComposition(latest.project).layers.find((candidate) => candidate.id === layer.id);
    const editedSelector = editedLayer?.textAnimator?.groups[0]?.selectors[0];
    expect(editedSelector?.kind === "range" ? editedSelector.end : undefined).toMatchObject({
      mode: "animated",
      keyframes: [
        { id: "range-end-start", value: 1 },
        { id: "range-end-finish", value: 100 },
      ],
    });
    expect(latest?.history.past).toHaveLength(1);
  });
});
