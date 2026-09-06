// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { onPlaybackFrame } from "../core/playback-frame";
import { createBlankProject } from "../core/project";
import { usePlayback } from "./use-timeline-playback";

const mock = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  play: vi.fn(async () => undefined),
  pause: vi.fn(),
  time: 0,
}));
vi.mock("../state/editor-store", () => ({
  useEditor: () => ({ state: mock.state, dispatch: mock.dispatch }),
}));
vi.mock("../core/audio-playback-engine", () => ({
  sharedAudioPlaybackEngine: {
    play: mock.play,
    pause: mock.pause,
    compositionTime: () => mock.time,
  },
}));
let root: Root;
let callbacks: Map<number, FrameRequestCallback>;
let nextId: number;
const project = createBlankProject();
const composition = project.compositions[0];
function Harness() {
  usePlayback(composition, composition.workArea);
  return null;
}
async function render() {
  await act(async () => root.render(<Harness />));
}
async function frame(time: number) {
  mock.time = time;
  const pending = [...callbacks.values()];
  callbacks.clear();
  await act(async () => {
    for (const callback of pending) callback(time * 1000);
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  callbacks = new Map();
  nextId = 0;
  mock.state = { project, currentTime: 0, playing: true, seekRevision: 0 };
  mock.time = 0;
  mock.dispatch.mockClear();
  mock.play.mockClear();
  mock.pause.mockClear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

it("does not restart audio when React acknowledges the playhead late", async () => {
  await render();
  for (let i = 1; i <= 60; i++) await frame(i / 60);
  expect(mock.play).toHaveBeenCalledTimes(1);
  expect(mock.dispatch).toHaveBeenCalledWith({ type: "setPlaybackTime", time: expect.any(Number) });
});
it("seeks exactly once for an explicit seek and preserves the precise paused frame", async () => {
  await render();
  await frame(0.5);
  mock.state = { ...mock.state, currentTime: 4, seekRevision: 1 };
  await render();
  await frame(0.6);
  await frame(4.123);
  expect(mock.play).toHaveBeenCalledTimes(2);
  expect(mock.play).toHaveBeenLastCalledWith(project, composition, 4, composition.workArea.end);
  mock.state = { ...mock.state, playing: false };
  await render();
  expect(mock.dispatch).toHaveBeenLastCalledWith({ type: "setPlaybackTime", time: 4.123 });
  expect(callbacks.size).toBe(0);
});
it("restarts at the work-area boundary once and cancels presentation on unmount", async () => {
  await render();
  await frame(composition.workArea.end);
  expect(mock.play).toHaveBeenCalledTimes(2);
  expect(mock.play).toHaveBeenLastCalledWith(
    project,
    composition,
    composition.workArea.start,
    composition.workArea.end,
  );
  await act(async () => root.unmount());
  expect(callbacks.size).toBe(0);
});

it("presents every frame while bounding expensive React updates", async () => {
  const presented = vi.fn();
  const unsubscribe = onPlaybackFrame(presented);
  vi.spyOn(performance, "now").mockImplementation(() => mock.time * 1000);
  try {
    await render();
    for (let i = 1; i <= 60; i++) await frame(i / 60);
    expect(presented).toHaveBeenCalledTimes(60);
    expect(mock.dispatch.mock.calls.length).toBeLessThanOrEqual(11);
    expect(presented).toHaveBeenLastCalledWith({ compositionId: composition.id, time: 1 });
  } finally {
    unsubscribe();
  }
});
