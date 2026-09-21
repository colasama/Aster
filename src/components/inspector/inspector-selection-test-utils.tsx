import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import {
  createGeneratorLayerForComposition,
  createLayerForComposition,
} from "../../core/layers/layer-factory";
import { activeComposition, createBlankProject } from "../../core/project/project";
import { createParticleSceneGenerator } from "../../core/scene/bundled-particle";
import { createDefaultParticleSettings } from "../../core/scene/particle-settings";
import type { Layer, Project } from "../../core/types";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, useEditor } from "../../state/editor-store";
import { Inspector } from "./Inspector";

export let editor: ReturnType<typeof useEditor>;
let root: Root;
let frame: FrameRequestCallback | undefined;

function Observe({ project }: { project: Project }) {
  const current = useEditor();
  editor = current;
  const { dispatch } = current;
  useEffect(() => {
    dispatch({ type: "loadProject", project });
    dispatch({ type: "setTime", time: 1 });
    dispatch({ type: "select", ids: activeComposition(project).layers.map((layer) => layer.id) });
  }, [dispatch, project]);
  return null;
}

export function setupInspectorTests() {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.setItem("aster.locale", "en-US");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      frame = undefined;
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    document.body.replaceChildren();
    window.localStorage.clear();
    frame = undefined;
    vi.restoreAllMocks();
  });
}

export function layerProject(kind: Layer["kind"] = "solid", count = 2) {
  const project = createBlankProject();
  const composition = activeComposition(project);
  composition.layers = Array.from({ length: count }, (_, index) => {
    const layer =
      kind === "generator"
        ? createGeneratorLayerForComposition(
            composition,
            createParticleSceneGenerator(createDefaultParticleSettings()),
          )
        : createLayerForComposition(kind, composition);
    layer.transform.position[0] = { mode: "static", value: (index + 1) * 10 };
    return layer;
  });
  return project;
}

export function mount(project: Project) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <EditorProvider>
          <Observe project={project} />
          <Inspector />
        </EditorProvider>
      </I18nProvider>,
    ),
  );
  return container;
}

export function layers() {
  return activeComposition(editor.state.project).layers;
}
export function field(label = "Position X", type = "number") {
  const element = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"][type="${type}"]`,
  );
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}
export function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
export function key(target: EventTarget, name: string) {
  act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
}
export function change(input: HTMLInputElement, value: string) {
  inputValue(input, value);
  key(input, "Enter");
}
export function select(input: HTMLSelectElement, value: string) {
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
export function pointer(target: EventTarget, type: string, clientX: number) {
  act(() =>
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX }),
    ),
  );
}
export function flush() {
  const callback = frame;
  frame = undefined;
  act(() => callback?.(0));
}
