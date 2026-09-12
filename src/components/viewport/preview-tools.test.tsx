// @vitest-environment happy-dom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activeComposition, createBlankProject } from "../../core/project/project";
import { I18nProvider } from "../../i18n/react";
import { createInitialState, editorReducer } from "../../state/editor-store";
import { PreviewTimecode } from "./PreviewTimecode";
import { useViewerGuides } from "./use-viewer-guides";
import { useViewportNavigation, VIEWPORT_ZOOM_COMMAND } from "./use-viewport-navigation";
import { copyViewportSnapshot, useViewportSnapshot } from "./use-viewport-snapshot";
import { ViewportRulers } from "./ViewportRulers";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem("aster.locale", "en-US");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("commits timecode once, rejects invalid input, cancels edits and clamps to the last frame", () => {
  const composition = activeComposition(createBlankProject());
  composition.duration = 5;
  composition.frameRate = { numerator: 24, denominator: 1 };
  const seek = vi.fn();
  act(() =>
    root.render(
      <I18nProvider>
        <PreviewTimecode composition={composition} time={1} onSeek={seek} />
      </I18nProvider>,
    ),
  );
  const input = container.querySelector("input");
  if (!input) throw new Error("Missing timecode input");
  const type = (value: string) =>
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = (value: string) =>
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
  type("48f");
  key("Enter");
  expect(seek.mock.calls).toEqual([[2]]);
  type("00:00:00:99");
  key("Enter");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(seek).toHaveBeenCalledOnce();
  key("Escape");
  expect(input.value).toBe("00:00:01:00");
  type("100s");
  key("Enter");
  expect(seek).toHaveBeenLastCalledWith(119 / 24);
});

it("adds, nudges, persists and locks reference guides without mutating the project", () => {
  function Harness() {
    const stageRef = useRef<HTMLDivElement>(null);
    const { guides, update } = useViewerGuides("project.composition");
    const [locked, setLocked] = useState(false);
    return (
      <I18nProvider>
        <div ref={stageRef}>
          <ViewportRulers
            stageRef={stageRef}
            width={1920}
            height={1080}
            zoom={0.25}
            guides={guides}
            onChange={update}
            locked={locked}
          />
          <button type="button" onClick={() => setLocked(!locked)}>
            Lock
          </button>
        </div>
      </I18nProvider>
    );
  }
  act(() => root.render(<Harness />));
  const ruler = container.querySelector<HTMLButtonElement>(".ruler-y");
  act(() => ruler?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const guide = container.querySelector<HTMLButtonElement>(".viewport-guide");
  expect(guide?.getAttribute("aria-label")).toBe("Y guide at 540 px");
  act(() =>
    guide?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }),
    ),
  );
  expect(guide?.getAttribute("aria-label")).toBe("Y guide at 550 px");
  expect(
    JSON.parse(localStorage.getItem("aster.viewer-guides.project.composition") ?? "[]")[0].position,
  ).toBe(550);
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Lock")
      ?.click(),
  );
  expect(guide?.disabled).toBe(true);
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Lock")
      ?.click(),
  );
  act(() => guide?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
  expect(container.querySelector(".viewport-guide")).toBeNull();
});

it("bounds snapshot memory, compares on demand and clears the old composition on context changes", () => {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    drawImage,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  const source = document.createElement("canvas");
  const target = document.createElement("canvas");
  source.width = 8192;
  source.height = 4096;
  expect(copyViewportSnapshot(source, target)).toBe(true);
  expect([target.width, target.height]).toEqual([2048, 1024]);
  function Harness({ context }: { context: string }) {
    const sourceRef = useRef<HTMLCanvasElement>(null);
    const snapshot = useViewportSnapshot(sourceRef, context);
    return (
      <>
        <canvas ref={sourceRef} />
        <canvas ref={snapshot.canvasRef} hidden={!snapshot.showing} data-snapshot />
        <button type="button" onClick={snapshot.capture}>
          Capture
        </button>
        <button type="button" disabled={!snapshot.available} onClick={snapshot.show}>
          Show
        </button>
      </>
    );
  }
  act(() => root.render(<Harness context="a" />));
  const buttons = container.querySelectorAll("button");
  act(() => buttons[0].click());
  act(() => buttons[1].click());
  expect(container.querySelector<HTMLCanvasElement>("[data-snapshot]")?.hidden).toBe(false);
  act(() => window.dispatchEvent(new Event("blur")));
  expect(container.querySelector<HTMLCanvasElement>("[data-snapshot]")?.hidden).toBe(true);
  act(() => root.render(<Harness context="b" />));
  expect(container.querySelector<HTMLCanvasElement>("[data-snapshot]")?.width).toBe(0);
  expect(buttons[1].disabled).toBe(true);
});

it("recomputes Fit on resize and zooms from the displayed scale when leaving Fit", () => {
  let resize: () => void = () => {};
  let width = 800;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  function Harness() {
    const spaceRef = useRef<HTMLDivElement>(null);
    const [state, setState] = useState(createInitialState);
    const zoom = useViewportNavigation(
      spaceRef,
      { width: 3840, height: 2160 },
      1,
      state,
      (action) => setState((current) => editorReducer(current, action)),
    );
    return (
      <div className="viewport-panel">
        <div ref={spaceRef} />
        <output>{zoom}</output>
      </div>
    );
  }
  act(() => root.render(<Harness />));
  expect(Number(container.querySelector("output")?.textContent)).toBeCloseTo(736 / 3840);
  width = 500;
  act(() => resize());
  const fitZoom = 436 / 3840;
  expect(Number(container.querySelector("output")?.textContent)).toBeCloseTo(fitZoom);
  act(() =>
    window.dispatchEvent(new CustomEvent(VIEWPORT_ZOOM_COMMAND, { detail: 1, cancelable: true })),
  );
  expect(Number(container.querySelector("output")?.textContent)).toBeCloseTo(fitZoom * 1.15);
  width = 900;
  act(() => resize());
  expect(Number(container.querySelector("output")?.textContent)).toBeCloseTo(fitZoom * 1.15);
});
