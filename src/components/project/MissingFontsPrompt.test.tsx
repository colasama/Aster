// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import * as availability from "../../core/media/font-availability";
import { createBlankProject } from "../../core/project/project";
import type { Project } from "../../core/types";
import * as desktopFonts from "../../desktop/fonts";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, type EditorState, useEditor } from "../../state/editor-store";
import { MissingFontsPrompt } from "./MissingFontsPrompt";

let root: Root | undefined;
let editor: { state: EditorState; load: (project: Project) => void } | undefined;

function Harness() {
  const { state, dispatch } = useEditor();
  editor = {
    state,
    load: (project) => dispatch({ type: "loadProject", project, markSaved: true }),
  };
  return <MissingFontsPrompt />;
}

function projectWith(families: string[]): Project {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.layers = families.map((fontFamily) => {
    const layer = createLayerForComposition("text", composition);
    if (!layer.textStyle) throw new Error("text layers carry a style");
    return { ...layer, textStyle: { ...layer.textStyle, fontFamily } };
  });
  return project;
}

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <I18nProvider>
        <EditorProvider>
          <Harness />
        </EditorProvider>
      </I18nProvider>,
    ),
  );
}

async function load(project: Project) {
  await act(async () => editor?.load(project));
  await act(async () => undefined);
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
  vi.spyOn(availability, "resolveFontAvailability").mockResolvedValue(
    (family) => family === "Georgia",
  );
  vi.spyOn(desktopFonts, "listSystemFontFamilies").mockResolvedValue(["Georgia"]);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  editor = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("MissingFontsPrompt", () => {
  it("stays closed when every loaded family is available", async () => {
    await mount();
    await load(projectWith(["Georgia"]));
    expect(dialog()).toBeNull();
  });

  it("keeps the fallback face when dismissed", async () => {
    await mount();
    const project = projectWith(["Noto Serif SC", "Noto Serif SC"]);
    await load(project);
    expect(dialog()?.textContent).toContain("Noto Serif SC");
    expect(dialog()?.textContent).toContain("2 layers");
    const [keep, replace] = [...(dialog()?.querySelectorAll("footer button") ?? [])];
    expect((replace as HTMLButtonElement).disabled).toBe(true);
    await act(async () => (keep as HTMLButtonElement).click());
    expect(dialog()).toBeNull();
    expect(editor?.state.project).toBe(project);
  });

  it("replaces the chosen family as one undoable edit", async () => {
    await mount();
    await load(projectWith(["Noto Serif SC", "Georgia"]));
    const input = dialog()?.querySelector<HTMLInputElement>('input[role="combobox"]');
    if (!input) throw new Error("Expected a replacement picker");
    await act(async () => input.focus());
    const option = document.querySelector<HTMLButtonElement>('[role="option"]');
    if (!option) throw new Error("Expected a system font option");
    await act(async () => option.click());
    const replace = dialog()?.querySelector<HTMLButtonElement>("footer button.primary");
    expect(replace?.disabled).toBe(false);
    await act(async () => replace?.click());
    expect(dialog()).toBeNull();
    expect(
      editor?.state.project.compositions[0].layers.map((l) => l.textStyle?.fontFamily),
    ).toEqual(['"Georgia"', "Georgia"]);
    expect(editor?.state.history.past).toHaveLength(1);
  });
});
