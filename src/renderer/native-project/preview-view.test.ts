// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from "vitest";
import { activeComposition, createDemoProject } from "../../core/project/project";
import type { DesktopNativePreview } from "../../core/rendering/native-preview-protocol";
import { createBeautyFrameRequest } from "../compositing/beauty-frame";
import { NativePreviewCanvas } from "./preview-canvas";
import { NativePreviewView } from "./preview-view";

const registry = vi.hoisted(() => ({ revision: 0 }));
vi.mock("../../core/scene/scene-generator-registry", async (original) => ({
  ...(await original<object>()),
  getSceneGeneratorRegistryRevision: () => registry.revision,
}));

vi.mock("./preview-canvas", () => ({ NativePreviewCanvas: { create: vi.fn() } }));
vi.mock("../../core/project/project-file", () => ({
  projectDocumentWithMediaImports: async (project: unknown) => project,
}));

beforeEach(() => {
  vi.resetAllMocks();
  registry.revision = 0;
});

async function fixture() {
  const project = createDemoProject();
  const request = createBeautyFrameRequest({
    project,
    composition: activeComposition(project),
    snapshot: { snapshotScope: "recovery-test", projectRevision: 1 },
    time: 0.125,
    width: 2,
    height: 2,
    antiAliasing: "off",
  });
  const pixels = { width: 2, height: 2, pixelFormat: "rgba", pixels: new ArrayBuffer(16) };
  const canvas = {
    canvas: {} as HTMLCanvasElement,
    memory: { adapterKey: "test", detectedAt: 0 },
    loss: undefined as Error | undefined,
    bind: vi.fn(),
    dispose: vi.fn(),
    present: vi.fn().mockResolvedValue({ pixels, skipped: false, render_and_share_ms: 1 }),
  };
  const ready = { adapter: { name: "test" } };
  const api = {
    available: vi.fn().mockResolvedValue(true),
    open: vi.fn().mockResolvedValue({ id: "first", ready }),
    replace: vi.fn().mockResolvedValue(ready),
    present: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(NativePreviewCanvas.create).mockResolvedValue(canvas as unknown as NativePreviewCanvas);
  const view = await NativePreviewView.create(
    canvas.canvas,
    api as unknown as DesktopNativePreview,
    vi.fn(),
    vi.fn(),
  );
  return { view, request, canvas, api, pixels };
}

test("activated generator changes replace the native snapshot without a project edit", async () => {
  const { view, request, api } = await fixture();
  await view.readback(request, 512);
  await view.readback(request, 512);
  expect(api.open).toHaveBeenCalledOnce();
  expect(api.replace).not.toHaveBeenCalled();
  registry.revision++;
  await view.readback(request, 512);
  expect(api.replace).toHaveBeenCalledOnce();
  await view.readback(request, 512);
  expect(api.replace).toHaveBeenCalledOnce();
  await view.dispose();
});

test("a crashed producer reopens the identical time-addressed snapshot once", async () => {
  const { view, request, canvas, api, pixels } = await fixture();
  canvas.present.mockRejectedValueOnce(new Error("Native preview exited (1): device removed"));
  api.close.mockRejectedValueOnce(new Error("Native preview exited (1): device removed"));
  expect(await view.readback(request, 512)).toEqual({ pixels: pixels.pixels, pixelFormat: "rgba" });
  expect(api.open).toHaveBeenCalledTimes(2);
  expect(api.open.mock.calls[0]).toEqual(api.open.mock.calls[1]);
  expect(api.close).toHaveBeenCalledWith("first");
  expect(canvas.present.mock.calls.map((args) => args[0])).toEqual([0.125, 0.125]);
});

test("exclusive benchmark presentation avoids editor updates while normal preview publishes", async () => {
  const { view, request, canvas } = await fixture();
  await view.beginExclusive();
  const metrics = await view.presentUncached(request, 512);
  expect(metrics.cpuMs).toBe(1);
  expect(canvas.present).toHaveBeenCalledWith(request.time, false, expect.any(Function), true);
  expect(view.presented).not.toHaveBeenCalled();
  view.endExclusive();
  view.queue(request, { visualization: "beauty", memoryBudgetMb: 512, playing: false });
  await view.settled();
  expect(view.presented).toHaveBeenCalledOnce();
  await view.dispose();
});

test("repeated producer failure stops after one retry and identity errors are never retried", async () => {
  for (const [message, attempts] of [
    ["Native preview exited (1): device removed", 2],
    ["Native preview delivery belongs to a different snapshot", 1],
  ] as const) {
    const { view, request, canvas, api } = await fixture();
    canvas.present.mockRejectedValue(new Error(message));
    await expect(view.readback(request, 512)).rejects.toThrow(message);
    expect(api.open).toHaveBeenCalledTimes(attempts);
    expect(canvas.present).toHaveBeenCalledTimes(attempts);
  }
});

test("an idle lost device is replaced before the next readback and cannot be reused", async () => {
  const { view, request, canvas, api } = await fixture();
  await view.readback(request, 512);
  canvas.loss = new Error("Preview GPU device lost: destroyed");
  const replacement = {
    ...canvas,
    loss: undefined,
    bind: vi.fn(),
    dispose: vi.fn(),
    present: vi
      .fn()
      .mockResolvedValue({ pixels: { pixels: new ArrayBuffer(16), pixelFormat: "rgba" } }),
  };
  vi.mocked(NativePreviewCanvas.create).mockResolvedValue(
    replacement as unknown as NativePreviewCanvas,
  );
  await view.readback(request, 512);
  expect(canvas.dispose).toHaveBeenCalledTimes(1);
  expect(canvas.present).toHaveBeenCalledTimes(1);
  expect(replacement.present).toHaveBeenCalledTimes(1);
  expect(api.open).toHaveBeenCalledTimes(2);
  expect(view.canvas).toBe(replacement);
});

test("snapshots serialize exact diagnostic requests before newer foreground work", async () => {
  const { view, request, canvas, api } = await fixture();
  const options = {
    visualization: "normal",
    selectedLayerId: "selected",
    memoryBudgetMb: 512,
    playing: false,
  };
  let finish!: () => void;
  canvas.present.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ skipped: false });
      }),
  );
  view.queue(request, options);
  await vi.waitFor(() => expect(canvas.present).toHaveBeenCalledOnce());
  const exact = { ...request, time: 0.123456789 };
  const captured = view.snapshot(exact, options);
  view.queue({ ...request, time: 0.7 }, options);
  await expect(view.snapshot(exact, options)).rejects.toThrow("busy");
  await expect(view.beginExclusive()).rejects.toThrow("exclusive");
  finish();
  const target = await captured;
  await view.settled();
  expect(canvas.present.mock.calls.map((args) => args[0])).toEqual([0.125, exact.time, 0.7]);
  expect(canvas.present.mock.calls[1]).toEqual([
    exact.time,
    false,
    expect.any(Function),
    false,
    target,
  ]);
  expect(api.open).toHaveBeenCalledWith(
    expect.objectContaining({
      visualization: "normal",
      selectedLayerId: "selected",
    }),
  );
  expect(view.presented).toHaveBeenCalledOnce();
  await view.dispose();
});

test("disposal cancels a pending snapshot without publishing a canvas", async () => {
  const { view, request, canvas } = await fixture();
  let finish!: () => void;
  canvas.present.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ skipped: false });
      }),
  );
  const captured = view.snapshot(request, {
    visualization: "beauty",
    memoryBudgetMb: 512,
    playing: false,
  });
  const rejected = expect(captured).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(canvas.present).toHaveBeenCalledOnce());
  const disposing = view.dispose();
  finish();
  await rejected;
  await disposing;
  const target = canvas.present.mock.calls[0][4] as HTMLCanvasElement;
  expect([target.width, target.height]).toEqual([0, 0]);
});
