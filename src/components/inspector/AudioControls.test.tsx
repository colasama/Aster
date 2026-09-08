// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { activeComposition, createBlankProject } from "../../core/project/project";
import type { Project } from "../../core/types";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, useEditor } from "../../state/editor-store";
import { AudioControls } from "./AudioControls";

let root: Root | undefined;
let latestEditor: ReturnType<typeof useEditor> | undefined;

function Harness({ project }: { project: Project }) {
  const editor = useEditor();
  latestEditor = editor;
  useEffect(() => {
    editor.dispatch({ type: "loadProject", project });
  }, [editor.dispatch, project]);
  const layer = activeComposition(editor.state.project).layers[0];
  return layer ? <AudioControls layer={layer} /> : null;
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

describe("audio layer source controls", () => {
  it("binds compatible footage to an independent audio layer with natural timing", () => {
    const project = createBlankProject();
    const composition = activeComposition(project);
    const layer = createLayerForComposition("audio", composition, 1);
    const source = {
      id: "dialogue-source",
      kind: "audio" as const,
      name: "dialogue.wav",
      mimeType: "audio/wav",
      contentIdentity: "sha256:dialogue",
      duration: 2,
      channels: 2,
      sampleRate: 48_000,
      streamIndex: 0,
      interpretation: { alpha: "ignore" as const, colorSpace: "srgb" as const },
    };
    project.sources = [
      source,
      {
        id: "still-source",
        kind: "still",
        name: "plate.png",
        mimeType: "image/png",
        contentIdentity: "sha256:plate",
        width: 100,
        height: 100,
        interpretation: { alpha: "straight", colorSpace: "srgb" },
      },
    ];
    composition.layers = [layer];
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <Harness project={project} />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const sourceSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Source"]');
    if (!sourceSelect) throw new Error("Expected audio source control");
    expect([...sourceSelect.options].map((option) => option.text)).toEqual([
      "No source",
      "dialogue.wav",
    ]);
    changeSelect(sourceSelect, source.id);

    let edited = activeComposition(latestEditor?.state.project ?? project).layers[0];
    expect(edited).toMatchObject({
      sourceId: source.id,
      name: "dialogue",
      inPoint: 1,
      outPoint: 3,
    });

    act(() => latestEditor?.dispatch({ type: "undo" }));
    edited = activeComposition(latestEditor?.state.project ?? project).layers[0];
    expect(edited).toMatchObject({ name: "Audio Layer", inPoint: 1 });
    expect(edited.sourceId).toBeUndefined();
  });
});

function changeSelect(target: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
