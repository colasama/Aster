import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeComposition, createDemoProject } from "../core/project/project";
import type { RenderSnapshotIdentity } from "../core/rendering/render-snapshot";
import type { GpuDiagnostics, RendererMetrics } from "../core/types";
import { buildPostProcessUniforms } from "./effects/post-process";
import { buildRootPostUniformPlan } from "./frame-plan/root-post-plan";
import { frameTimeToNumber } from "./frame-plan/time";
import type { FramePlanSliceData } from "./frame-plan/types";
import { WebGpuRenderer } from "./webgpu-renderer";

const harness = vi.hoisted(() => ({
  resources: {} as Record<string, unknown>,
  plans: [] as FramePlanSliceData[],
  changeExposure: false,
}));

vi.mock("./renderer-resources", () => ({
  RendererResources: class {
    constructor() {
      Object.assign(this, harness.resources);
    }
  },
}));

vi.mock("./frame-plan/root-post-plan", async (original) => {
  const actual = await original<typeof import("./frame-plan/root-post-plan")>();
  return {
    ...actual,
    buildRootPostUniformPlan: vi.fn((input: Parameters<typeof buildRootPostUniformPlan>[0]) => {
      const plan = actual.buildRootPostUniformPlan(input);
      if (harness.changeExposure)
        new DataView(plan.blobs[0].buffer, plan.blobs[0].byteOffset).setFloat32(12, 1.75, true);
      harness.plans.push(plan);
      return plan;
    }),
  };
});

function setup() {
  const postBuffer = {} as GPUBuffer;
  const uploads: { buffer: GPUBuffer; bytes: Uint8Array }[] = [];
  const encoded = new Error("test stops at the unchanged command-encoding boundary");
  const device = {
    queue: {
      writeBuffer: (
        buffer: GPUBuffer,
        _offset: number,
        data: ArrayBuffer | ArrayBufferView,
        dataOffset = 0,
        size?: number,
      ) => {
        const source = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data, dataOffset, size);
        uploads.push({
          buffer,
          bytes: source.slice(),
        });
      },
    },
    createCommandEncoder: vi.fn(() => {
      throw encoded;
    }),
  } as unknown as GPUDevice;
  let pending = false;
  let wait = async () => {};
  const media = {
    estimatedBytes: 0,
    beginFrame: vi.fn(),
    abortFrame: vi.fn(),
    sweep: vi.fn(),
    mediaReady: () => !pending,
    get hasPendingFrameResources() {
      return pending;
    },
    waitForFrameResources: () => wait(),
  };
  const read = vi.fn(async () => ({ pixels: new ArrayBuffer(4), pixelFormat: "rgba" as const }));
  harness.resources = {
    postUniformBuffer: postBuffer,
    lightingBuffer: {},
    sceneTexture: {},
    postBindGroup: {},
    shapeBufferBytes: 0,
    configureShadowMap: vi.fn(),
    sceneGenerators: { beginFrame: vi.fn(), sweep: vi.fn(), diagnostics: [], estimatedBytes: 0 },
    precompositionSurfaces: {
      prepare: () => ({ diagnostics: [], mediaInstanceIds: new Set(["media"]), residentBytes: 0 }),
    },
    layerEffects: { estimatedTextureBytes: () => 0 },
    auxiliaryBuffers: { estimatedBytes: 0 },
    motionBlur: { estimatedBytes: 0 },
    surfacePostEffects: { estimatedBytes: 0 },
    mediaTextures: media,
    frameReadback: { reserve: () => ({ read, abort: vi.fn() }) },
  };
  // Construct the real orchestration object with resource allocation replaced by bounded fakes.
  const Renderer = WebGpuRenderer as unknown as new (
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    diagnostics: GpuDiagnostics,
    invalidate: () => void,
  ) => WebGpuRenderer;
  const renderer = new Renderer(
    device,
    {} as GPUCanvasContext,
    "rgba8unorm",
    {} as GpuDiagnostics,
    () => {},
  );
  const project = createDemoProject();
  const composition = activeComposition(project);
  composition.layers = [];
  composition.motionBlur = { ...composition.motionBlur, enabled: false };
  const snapshot = { snapshotScope: "loaded:test-project", projectRevision: 13 };
  return {
    renderer,
    project,
    composition,
    snapshot,
    device,
    uploads,
    postBuffer,
    encoded,
    media,
    read,
    setPending(value: boolean) {
      pending = value;
    },
    setWait(callback: () => Promise<void>) {
      wait = callback;
    },
  };
}

beforeEach(() => {
  harness.plans = [];
  harness.changeExposure = false;
  vi.mocked(buildRootPostUniformPlan).mockClear();
});

describe("production root post-plan integration", () => {
  it("uploads the supplied plan bytes at the existing encoding boundary", () => {
    const f = setup();
    const time = 0.1 + Number.EPSILON;
    expect(() => f.renderer.render(f.composition, time, f.snapshot, false, f.project)).toThrow(
      f.encoded,
    );
    expect(harness.plans).toHaveLength(1);
    const plan = harness.plans[0];
    expect(frameTimeToNumber(plan.metadata.header.time)).toBe(time);
    expect(plan.metadata.header).toMatchObject({
      snapshot_scope: f.snapshot.snapshotScope,
      project_revision: 13,
      composition_id: f.composition.id,
      target: { width: 1, height: 1 },
      render_target: { width: 1, height: 1 },
    });
    const old = buildPostProcessUniforms(1, 1, time);
    expect(
      f.uploads.filter((upload) => upload.buffer === f.postBuffer).map((upload) => upload.bytes),
    ).toEqual([new Uint8Array(old.buffer)]);

    harness.changeExposure = true;
    expect(() => f.renderer.render(f.composition, time, f.snapshot, false, f.project)).toThrow(
      f.encoded,
    );
    const supplied = harness.plans[1].blobs[0];
    const last = f.uploads[f.uploads.length - 1]?.bytes;
    expect(last).toEqual(supplied);
    if (!last) throw new Error("Expected an uploaded post-process payload");
    expect(new DataView(last.buffer).getFloat32(12, true)).toBe(1.75);
  });

  it("does not build or upload the post slice while production media is held", () => {
    const f = setup();
    f.setPending(true);
    const result = f.renderer.render(
      f.composition,
      0.1,
      f.snapshot,
      false,
      f.project,
      undefined,
      true,
    );
    expect(result.mediaPending).toBe(true);
    expect(buildRootPostUniformPlan).not.toHaveBeenCalled();
    expect(f.uploads.some((upload) => upload.buffer === f.postBuffer)).toBe(false);
    expect(f.device.createCommandEncoder).not.toHaveBeenCalled();
    expect(f.media.abortFrame).toHaveBeenCalledOnce();
  });

  it("captures one caller identity before media discovery and uses it for recapture", async () => {
    const f = setup();
    f.setPending(true);
    let ready!: () => void;
    const barrier = new Promise<void>((resolve) => {
      ready = resolve;
    });
    f.setWait(() => barrier);
    let discovered!: () => void;
    const discovery = new Promise<void>((resolve) => {
      discovered = resolve;
    });
    const identities: RenderSnapshotIdentity[] = [];
    const render = vi
      .spyOn(f.renderer, "render")
      .mockImplementation((_composition, _time, snapshot) => {
        identities.push(snapshot);
        discovered();
        return {} as RendererMetrics;
      });
    const capture = f.renderer.renderRawFrame(f.composition, -0, f.snapshot, f.project, true);
    f.snapshot.projectRevision = 99;
    f.snapshot.snapshotScope = "changed:caller";
    await discovery;
    f.setPending(false);
    ready();
    await capture;
    expect(render).toHaveBeenCalledTimes(2);
    expect(identities).toEqual([
      { snapshotScope: "loaded:test-project", projectRevision: 13 },
      { snapshotScope: "loaded:test-project", projectRevision: 13 },
    ]);
    expect(identities[0]).toBe(identities[1]);
    expect(Object.is(render.mock.calls[1][1], -0)).toBe(true);
    expect(f.read).toHaveBeenCalledTimes(2);
  });
});
