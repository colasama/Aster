// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activeComposition, createBlankProject } from "../../core/project/project";
import { I18nProvider } from "../../i18n/react";
import { CanvasFallbackRenderer } from "../../renderer/canvas-fallback";
import { WebGpuRenderer } from "../../renderer/webgpu-renderer";
import { createInitialState, type EditorState, useEditor } from "../../state/editor-store";
import { Viewport } from "./Viewport";

vi.mock("../../state/editor-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/editor-store")>()),
  useEditor: vi.fn(),
}));
vi.mock("../workspace/DockWorkspace", () => ({ useWorkspaceApi: () => ({}) }));

let root: Root;
let container: HTMLDivElement;
let state: EditorState;
const dispatch = vi.fn();
const resizeCallbacks = new Set<() => void>();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state = {
    ...createInitialState(),
    project: createBlankProject(),
    selection: [],
    antiAliasing: "off",
  };
  activeComposition(state.project).layers = [];
  vi.mocked(useEditor).mockImplementation(() => ({ state, dispatch }));
  vi.stubGlobal("devicePixelRatio", 2);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(readonly callback: () => void) {}
      observe() {
        resizeCallbacks.add(this.callback);
      }
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(
      0,
      0,
      parseFloat(this.style.width) || 800,
      parseFloat(this.style.height) || 600,
    );
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      canvas: this,
      clearRect: vi.fn(),
      fillRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  // Exercise the real presentation backend without requiring a GPU in the DOM test environment.
  vi.spyOn(WebGpuRenderer, "create").mockRejectedValue("Test Canvas fallback");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  resizeCallbacks.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderViewport() {
  await act(async () => {
    root.render(
      <I18nProvider>
        <Viewport />
      </I18nProvider>,
    );
  });
  const canvas = container.querySelector<HTMLCanvasElement>(".composition-stage canvas");
  if (!canvas) throw new Error("Missing preview canvas");
  return canvas;
}

it("keeps rendered pixels and targets stable through zoom, Fit, panel resize and DPI changes", async () => {
  const render = vi.spyOn(CanvasFallbackRenderer.prototype, "render");
  const resize = vi.spyOn(CanvasFallbackRenderer.prototype, "resize");
  const canvas = await renderViewport();
  const composition = activeComposition(state.project);
  expect([canvas.width, canvas.height]).toEqual([composition.width, composition.height]);
  expect(render).toHaveBeenCalled();
  render.mockClear();
  resize.mockClear();
  const widthWrites = vi.spyOn(canvas, "width", "set");
  const heightWrites = vi.spyOn(canvas, "height", "set");

  for (const zoom of [0.1, 1, 4, 8]) {
    state = { ...state, viewportZoomMode: "manual", viewportZoom: zoom };
    await renderViewport();
    act(() => {
      for (const callback of resizeCallbacks) callback();
    });
    expect(container.querySelector<HTMLElement>(".composition-stage")?.style.width).toBe(
      `${composition.width * zoom}px`,
    );
  }
  vi.stubGlobal("devicePixelRatio", 3);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  state = { ...state, viewportZoomMode: "fit" };
  await renderViewport();
  act(() => {
    for (const callback of resizeCallbacks) callback();
  });
  expect([canvas.width, canvas.height]).toEqual([composition.width, composition.height]);
  expect(widthWrites).not.toHaveBeenCalled();
  expect(heightWrites).not.toHaveBeenCalled();
  expect(resize).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  expect(WebGpuRenderer.create).toHaveBeenCalledOnce();
});

it("resizes and redraws for preview quality and composition dimensions without recreating the renderer", async () => {
  const render = vi.spyOn(CanvasFallbackRenderer.prototype, "render");
  const canvas = await renderViewport();
  const composition = activeComposition(state.project);
  for (const quality of [0.5, 0.25, 1] as const) {
    render.mockClear();
    state = { ...state, previewQuality: quality };
    await renderViewport();
    expect([canvas.width, canvas.height]).toEqual([
      composition.width * quality,
      composition.height * quality,
    ]);
    expect(render).toHaveBeenCalled();
  }
  state = {
    ...state,
    previewQuality: 0.5,
    project: {
      ...state.project,
      compositions: [{ ...composition, width: 2560, height: 1440 }],
    },
  };
  await renderViewport();
  expect([canvas.width, canvas.height]).toEqual([1280, 720]);
  expect(WebGpuRenderer.create).toHaveBeenCalledOnce();
});
