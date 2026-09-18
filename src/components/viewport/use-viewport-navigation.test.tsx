// @vitest-environment happy-dom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInitialState, type EditorState, editorReducer } from "../../state/editor-store";
import { useViewportNavigation } from "./use-viewport-navigation";

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

function Harness({ views = 1, hand = false }: { views?: number; hand?: boolean }) {
  const spaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<EditorState>(() => ({
    ...createInitialState(),
    viewportZoomMode: "manual" as const,
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
      <div ref={spaceRef} {...navigation.handlers} data-space tabIndex={-1}>
        <div
          ref={stageRef}
          data-stage
          data-views={views}
          style={{
            width: 1920 * navigation.zoom,
            height: 1080 * navigation.zoom,
            left: navigation.offset.x,
            top: navigation.offset.y,
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
