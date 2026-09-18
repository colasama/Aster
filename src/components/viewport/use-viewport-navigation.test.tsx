// @vitest-environment happy-dom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInitialState, type EditorState, editorReducer } from "../../state/editor-store";
import type { ViewportNavigationMode } from "../../ui/viewport-zoom";
import { useViewportNavigation, VIEWPORT_ZOOM_COMMAND } from "./use-viewport-navigation";

let root: Root;
let container: HTMLDivElement;
let uiScale = 1;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  uiScale = 1;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.hasAttribute("data-stage")) return new DOMRect(10, 20, 800 * uiScale, 600 * uiScale);
    const width = Number.parseFloat(this.style.width);
    const height = Number.parseFloat(this.style.height);
    const x = Number.parseFloat(this.style.left);
    const y = Number.parseFloat(this.style.top);
    const split = this.dataset.views === "2" ? (width + 32) / 2 : 0;
    return new DOMRect(
      10 + ((800 - width) / 2 + x - split) * uiScale,
      20 + ((600 - height) / 2 + y) * uiScale,
      width * uiScale,
      height * uiScale,
    );
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({
  views = 1,
  hand = false,
  mode = "smooth",
}: {
  views?: number;
  hand?: boolean;
  mode?: ViewportNavigationMode;
}) {
  const spaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<EditorState>(() => ({
    ...createInitialState(),
    viewportZoomMode: "manual" as const,
    viewportNavigationMode: mode,
  }));
  const navigation = useViewportNavigation(
    spaceRef,
    stageRef,
    { width: 1920, height: 1080 },
    views,
    { ...state, activeTool: hand ? "hand" : "select" },
    (action) => setState((current) => editorReducer(current, action)),
  );
  return (
    <>
      <div
        ref={spaceRef}
        {...navigation.handlers}
        className="viewport-panel"
        data-space
        tabIndex={-1}
      >
        <div
          ref={stageRef}
          data-stage
          data-views={views}
          style={{
            width: 1920 * navigation.zoom,
            height: 1080 * navigation.zoom,
            // happy-dom rejects scientific notation for near-zero CSS lengths.
            left: `${navigation.offset.x.toFixed(8)}px`,
            top: `${navigation.offset.y.toFixed(8)}px`,
          }}
        />
        <textarea aria-label="Edit text" />
      </div>
      <output>
        {JSON.stringify({
          zoom: navigation.zoom,
          ...navigation.offset,
          panning: navigation.panning,
        })}
      </output>
      <button
        type="button"
        onClick={() => setState((current) => editorReducer(current, { type: "fitViewport" }))}
      >
        Fit
      </button>
      <button
        type="button"
        data-toggle-mode
        onClick={() =>
          setState((current) =>
            editorReducer(current, {
              type: "setViewportNavigationMode",
              mode: current.viewportNavigationMode === "smooth" ? "legacy" : "smooth",
            }),
          )
        }
      >
        Toggle navigation
      </button>
    </>
  );
}

function readView(): { zoom: number; x: number; y: number; panning: boolean } {
  return JSON.parse(container.querySelector("output")?.textContent ?? "{}");
}

function wheel(target: Element, options: WheelEventInit = {}) {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: -100,
    clientX: 170,
    clientY: 230,
    ...options,
  });
  // happy-dom's WheelEvent omits the MouseEvent coordinates and modifier keys.
  Object.assign(event, { clientX: 170, clientY: 230, ...options });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

it.each([1, 2])(
  "keeps the pointer's composition point fixed in %s views, including UI scaling",
  (views) => {
    uiScale = 1.5;
    act(() => root.render(<Harness views={views} />));
    const stage = container.querySelector("[data-stage]");
    if (!stage) throw new Error("Missing stage");
    const before = stage.getBoundingClientRect();
    const x = (170 - before.left) / before.width;
    const y = (230 - before.top) / before.height;
    expect(wheel(stage).defaultPrevented).toBe(true);
    const after = stage.getBoundingClientRect();
    expect(after.left + x * after.width).toBeCloseTo(170);
    expect(after.top + y * after.height).toBeCloseTo(230);
    expect(readView().zoom).toBeCloseTo(0.25 * 1.12);
    wheel(stage, { deltaY: 100 });
    expect(readView().x).toBeCloseTo(0);
    expect(readView().y).toBeCloseTo(0);
  },
);

it("uses Alt to anchor the view center and leaves text editing wheel events alone", () => {
  act(() => root.render(<Harness />));
  const space = container.querySelector("[data-space]");
  const input = container.querySelector("textarea");
  if (!space || !input) throw new Error("Missing viewer");
  expect(wheel(space, { altKey: true, ctrlKey: true }).defaultPrevented).toBe(true);
  expect(readView()).toMatchObject({ x: 0, y: 0 });
  expect(readView().zoom).toBeCloseTo(0.25 * 1.12 ** 0.25);
  const zoom = readView().zoom;
  expect(wheel(input).defaultPrevented).toBe(false);
  expect(wheel(space, { deltaY: 0 }).defaultPrevented).toBe(false);
  expect(readView().zoom).toBe(zoom);
});

it.each([1, 2])(
  "uses fixed Legacy zoom steps with center/Alt pointer anchors in %s views",
  (views) => {
    uiScale = 1.5;
    act(() => root.render(<Harness mode="legacy" views={views} />));
    const stage = container.querySelector("[data-stage]");
    if (!stage) throw new Error("Missing stage");
    const before = stage.getBoundingClientRect();
    const x = (610 - before.left) / before.width;
    const y = (470 - before.top) / before.height;
    expect(wheel(stage).defaultPrevented).toBe(true);
    expect(readView().zoom).toBe(1 / 3);
    const centered = stage.getBoundingClientRect();
    expect(centered.left + x * centered.width).toBeCloseTo(610);
    expect(centered.top + y * centered.height).toBeCloseTo(470);
    const px = (170 - centered.left) / centered.width;
    const py = (230 - centered.top) / centered.height;
    wheel(stage, { altKey: true, ctrlKey: true, shiftKey: true });
    expect(readView().zoom).toBe(0.5);
    const pointed = stage.getBoundingClientRect();
    expect(pointed.left + px * pointed.width).toBeCloseTo(170);
    expect(pointed.top + py * pointed.height).toBeCloseTo(230);
    wheel(stage, { deltaY: 100, altKey: true });
    expect(readView().zoom).toBe(1 / 3);
    expect(stage.getBoundingClientRect().left).toBeCloseTo(centered.left);
  },
);

it("pans Legacy vertically with Ctrl/Cmd and horizontally with Shift, respecting wheel units and UI scale", () => {
  uiScale = 2;
  act(() => root.render(<Harness mode="legacy" />));
  const space = container.querySelector("[data-space]");
  if (!space) throw new Error("Missing viewer");
  wheel(space, { ctrlKey: true });
  expect(readView()).toMatchObject({ zoom: 0.25, x: 0, y: 50 });
  wheel(space, { metaKey: true, deltaY: 2, deltaMode: 1 });
  expect(readView()).toMatchObject({ zoom: 0.25, x: 0, y: 34 });
  wheel(space, { shiftKey: true, ctrlKey: true, deltaY: 1, deltaMode: 2 });
  expect(readView()).toMatchObject({ zoom: 0.25, x: -300, y: 34 });
  wheel(space, { shiftKey: true, deltaY: 0, deltaX: -100 });
  expect(readView()).toMatchObject({ zoom: 0.25, x: -250, y: 34 });
  const input = container.querySelector("textarea");
  if (!input) throw new Error("Missing input");
  expect(wheel(input, { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(wheel(space, { deltaY: Number.NaN }).defaultPrevented).toBe(false);
  expect(readView()).toMatchObject({ zoom: 0.25, x: -250, y: 34 });
});

it("uses fixed Legacy magnification for viewer menu commands", () => {
  act(() => root.render(<Harness mode="legacy" />));
  for (const [direction, zoom] of [
    [1, 1 / 3],
    [1, 0.5],
    [-1, 1 / 3],
  ]) {
    const event = new CustomEvent(VIEWPORT_ZOOM_COMMAND, { detail: direction, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(readView()).toMatchObject({ zoom, x: 0, y: 0 });
  }
});

it("switches navigation immediately without resetting magnification or position", () => {
  act(() => root.render(<Harness />));
  const space = container.querySelector("[data-space]");
  if (!space) throw new Error("Missing viewer");
  wheel(space);
  const before = readView();
  act(() => container.querySelector<HTMLButtonElement>("[data-toggle-mode]")?.click());
  expect(readView()).toEqual(before);
  wheel(space, { ctrlKey: true });
  expect(readView()).toMatchObject({ zoom: before.zoom, x: before.x, y: before.y + 100 });
  wheel(space);
  expect(readView().zoom).toBe(1 / 3);
  act(() => container.querySelector<HTMLButtonElement>("[data-toggle-mode]")?.click());
  wheel(space, { ctrlKey: true });
  expect(readView().zoom).toBeCloseTo((1 / 3) * 1.12 ** 0.25);
});

it.each([false, true])(
  "pans freely using the middle button or Hand tool (hand=%s), accelerates with Shift and resets on Fit",
  (hand) => {
    act(() => root.render(<Harness hand={hand} />));
    const space = container.querySelector<HTMLDivElement>("[data-space]");
    if (!space) throw new Error("Missing viewer");
    space.setPointerCapture = vi.fn();
    space.hasPointerCapture = vi.fn().mockReturnValue(true);
    space.releasePointerCapture = vi.fn();
    const pointer = (type: string, options: PointerEventInit = {}) =>
      act(() => {
        space.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            clientX: 100,
            clientY: 100,
            ...options,
          }),
        );
      });
    pointer("pointerdown", { button: hand ? 0 : 1 });
    pointer("pointermove", { clientX: 120, clientY: 110 });
    expect(readView()).toMatchObject({ x: 20, y: 10, panning: true });
    pointer("pointermove", { clientX: 130, clientY: 120, shiftKey: true });
    expect(readView()).toMatchObject({ x: 50, y: 40 });
    pointer("pointermove", { clientX: 140, clientY: 125 });
    expect(readView()).toMatchObject({ x: 60, y: 45 });
    pointer("pointercancel");
    pointer("pointermove", { clientX: 300 });
    expect(readView()).toMatchObject({ x: 60, y: 45, panning: false });
    pointer("pointerdown", { button: 1 });
    act(() => window.dispatchEvent(new Event("blur")));
    expect(readView().panning).toBe(false);
    expect(space.releasePointerCapture).toHaveBeenCalled();
    act(() => container.querySelector("button")?.click());
    expect(readView()).toMatchObject({ x: 0, y: 0 });
  },
);
