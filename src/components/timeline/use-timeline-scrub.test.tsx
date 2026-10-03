// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWindowPointerDrag } from "../use-window-pointer-drag";
import { timelineZoomStore } from "./timeline-zoom-store";
import { useTimelineScrub } from "./use-timeline-scrub";

let root: Root;
let now = 0;
let nextId = 0;
const frames = new Map<number, FrameRequestCallback>();
const seek = vi.fn();
function Harness({ enabled = true, compositionId = "composition" }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useWindowPointerDrag();
  const start = useTimelineScrub({
    scrollRef,
    canvasRef,
    width: 600,
    duration: 20,
    frameDuration: 1 / 30,
    targets: [],
    seek,
    startPointerDrag: drag.start,
    enabled,
    compositionId,
  });
  return (
    <div ref={scrollRef} id="scroll">
      <div ref={canvasRef} id="ruler" onPointerDown={start} />
    </div>
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  now = 0;
  frames.clear();
  seek.mockClear();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  timelineZoomStore.set(100 / 82);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  timelineZoomStore.set(1);
});
function advance(count = 1) {
  for (let i = 0; i < count; i++) {
    now += 16;
    const pending = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of pending) callback(now);
    });
  }
}
function begin(clientX: number) {
  const scroll = document.querySelector<HTMLDivElement>("#scroll");
  const ruler = document.querySelector<HTMLDivElement>("#ruler");
  if (!scroll || !ruler) throw new Error("Missing fixture");
  scroll.scrollLeft = 400;
  act(() =>
    ruler.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 440 }),
    ),
  );
  move(clientX);
  return scroll;
}
function move(clientX: number) {
  act(() => window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX })));
  advance();
}

it.each([200, 800])("keeps scrolling and seeking with a stationary pointer at %s", (clientX) => {
  const scroll = begin(clientX);
  advance(5);
  const previous = scroll.scrollLeft;
  const previousSeek = seek.mock.lastCall?.[0];
  advance(5);
  if (clientX < 286) {
    expect(scroll.scrollLeft).toBeLessThan(previous);
    expect(seek.mock.lastCall?.[0]).toBeLessThan(previousSeek);
  } else {
    expect(scroll.scrollLeft).toBeGreaterThan(previous);
    expect(seek.mock.lastCall?.[0]).toBeGreaterThan(previousSeek);
  }
  const x = seek.mock.lastCall?.[0] * 100 - scroll.scrollLeft;
  expect(x).toBeGreaterThanOrEqual(0);
  expect(x).toBeLessThan(314);
  advance(250);
  expect(scroll.scrollLeft).toBe(clientX < 286 ? 0 : 2000 - 314);
});

it("stops scrolling in the center and resumes at the opposite edge", () => {
  const scroll = begin(800);
  advance(5);
  move(440);
  const stopped = scroll.scrollLeft;
  advance(5);
  expect(scroll.scrollLeft).toBe(stopped);
  move(200);
  advance(5);
  expect(scroll.scrollLeft).toBeLessThan(stopped);
});

it.each(["pointerup", "pointercancel", "blur", "Escape", "hidden", "composition", "unmount"])(
  "stops on %s",
  (reason) => {
    const scroll = begin(800);
    advance(5);
    act(() => {
      if (reason === "Escape")
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      else if (reason === "hidden") root.render(<Harness enabled={false} />);
      else if (reason === "composition") root.render(<Harness compositionId="other" />);
      else if (reason === "unmount") root.render(null);
      else if (reason === "blur") window.dispatchEvent(new Event("blur"));
      else window.dispatchEvent(new PointerEvent(reason, { pointerId: 7, clientX: 800 }));
    });
    const stopped = scroll.scrollLeft;
    const calls = seek.mock.calls.length;
    advance(10);
    expect(scroll.scrollLeft).toBe(stopped);
    expect(seek).toHaveBeenCalledTimes(calls);
  },
);
