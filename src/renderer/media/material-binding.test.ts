import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import { runCpuTask } from "../../core/scheduling/cpu-scheduler";
import { buildFrameHeader } from "../frame-plan/root-post-plan";
import type { GeometryBatch } from "../geometry/geometry";
import { ExactFrameCaptureQueue } from "../gpu/exact-frame-resource-barrier";
import { MaterialTextureRenderer } from "./material-textures";

vi.mock("../../core/scheduling/cpu-scheduler", () => ({ runCpuTask: vi.fn() }));
vi.mock("../scene/scene-pipelines", () => ({
  createMaterialShapePipelines: () => ({ normal: {}, multiply: {} }),
}));

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function fixture() {
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    createBindGroupLayout: vi.fn(() => ({})),
    createSampler: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createBindGroup: vi.fn(() => ({})),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null as GPUError | null),
    queue: { writeTexture: vi.fn(), writeBuffer: vi.fn(), copyExternalImageToTexture: vi.fn() },
  };
  const invalidate = vi.fn();
  const renderer = new MaterialTextureRenderer(
    device as unknown as GPUDevice,
    "rgba16float",
    {} as GPUBindGroupLayout,
    invalidate,
    vi.fn(),
  );
  const composition = createBlankComposition();
  const layer = createLayerForComposition("mesh", composition);
  const batch: GeometryBatch = {
    layer,
    instanceId: "mesh",
    resourceInstanceId: "mesh",
    selectionId: "mesh",
    firstVertex: 0,
    vertexCount: 3,
  };
  const header = buildFrameHeader({
    snapshot: { snapshotScope: "material-test", projectRevision: 0 },
    compositionId: composition.id,
    time: 0,
    frameRate: composition.frameRate,
    target: { width: 1, height: 1 },
    renderTarget: { width: 1, height: 1 },
    antiAliasing: "off",
  });
  return { device, renderer, composition, layer, batch, invalidate, header };
}

it("draws supplied material settings after authoring changes and rejects retired owners", async () => {
  const f = fixture();
  f.composition.environment = {
    enabled: true,
    intensity: 2.5,
    rotation: -90,
    source: { name: "test.hdr", mimeType: "image/vnd.radiance", dataUrl: "hdr:fixture" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })),
  );
  const pixels = new Uint16Array(128);
  pixels.set([0x4000, 0x3c00, 0x3800, 0x3c00]);
  vi.mocked(runCpuTask).mockResolvedValue({ width: 1, height: 1, bytesPerRow: 256, pixels });
  f.renderer.prepare(f.composition, [f.batch], f.header);
  const pending = structuredClone(f.batch.materialTexturePlan);
  await vi.waitFor(() => expect(f.renderer.hasPendingResources).toBe(false));
  expect(f.renderer.bindingFor(pending, "normal")).toBeUndefined();
  f.renderer.prepare(f.composition, [f.batch], f.header);
  const supplied = structuredClone(f.batch.materialTexturePlan);
  f.composition.environment.intensity = 17;
  f.composition.environment.rotation = 30;
  f.layer.kind = "solid";
  expect(f.renderer.bindingFor(supplied, "normal")).toBeDefined();
  expect(f.device.queue.writeBuffer.mock.calls[0][2]).toEqual(new Float32Array([1, 2.5, 0, 0.75]));
  expect(f.device.queue.writeTexture.mock.calls[0][1]).toEqual(
    new Uint8Array([0, 64, 0, 60, 0, 56, 0, 60]),
  );
  const count = f.device.createBindGroup.mock.calls.length;
  f.renderer.prepare(f.composition, [], f.header);
  expect(() => f.renderer.bindingFor(supplied, "normal")).toThrow(
    expect.objectContaining({ code: "missing_resource" }),
  );
  expect(f.device.createBindGroup).toHaveBeenCalledTimes(count);
  f.renderer.destroy();
});

it("binds normal hashes independently of draw IDs and replaces retired duplicate owners", async () => {
  const f = fixture();
  f.layer.mesh = {
    name: "mesh",
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    materialTextures: {
      normal: { dataUrl: "normal:shared", mimeType: "image/png", texCoord: 0, scale: 0.75 },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]),
    })),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
  );
  const second: GeometryBatch = { ...f.batch, resourceInstanceId: "second" };
  f.renderer.prepare(f.composition, [f.batch], f.header);
  await vi.waitFor(() => expect(f.renderer.hasPendingResources).toBe(false));
  f.renderer.prepare(f.composition, [f.batch, second], f.header);
  await vi.waitFor(() => expect(f.renderer.hasPendingResources).toBe(false));
  f.renderer.prepare(f.composition, [f.batch, second], f.header);
  expect(f.batch.materialTexturePlan?.normalHash).toBe(second.materialTexturePlan?.normalHash);
  if (!second.materialTexturePlan) throw Error("Material plan missing");
  const supplied = { ...second.materialTexturePlan, instanceId: "independent-wire-instance" };
  expect(f.renderer.bindingFor(supplied, "normal")).toBeDefined();
  const before = f.device.createBindGroup.mock.calls.length;
  const firstTexture = f.device.createTexture.mock.results[0].value;
  const secondTexture = f.device.createTexture.mock.results[1].value;
  f.renderer.prepare(f.composition, [second], f.header);
  expect(firstTexture.destroy).toHaveBeenCalledOnce();
  expect(f.renderer.bindingFor(supplied, "normal")).toBeDefined();
  expect(f.device.createBindGroup).toHaveBeenCalledTimes(before + 1);
  expect(secondTexture.createView).toHaveBeenCalledOnce();
  f.renderer.prepare(f.composition, [], f.header);
  expect(() => f.renderer.bindingFor(supplied, "normal")).toThrow(
    expect.objectContaining({ code: "missing_resource" }),
  );
  f.renderer.destroy();
});

it("destroys a normal upload retired while GPU validation is pending", async () => {
  const f = fixture();
  f.layer.mesh = {
    name: "mesh",
    positions: [],
    indices: [],
    normals: [],
    uvs: [],
    materialTextures: {
      normal: { dataUrl: "normal:fixture", mimeType: "image/png", texCoord: 0, scale: 1 },
    },
  };
  const bitmap = { width: 1, height: 1, close: vi.fn() };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]),
    })),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
  let complete: (value: GPUError | null) => void = () => {};
  f.device.popErrorScope.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  f.renderer.prepare(f.composition, [f.batch], f.header);
  await vi.waitFor(() => expect(f.device.popErrorScope).toHaveBeenCalledOnce());
  const texture = f.device.createTexture.mock.results[0].value;
  f.renderer.prepare(f.composition, [], f.header);
  complete(null);
  await vi.waitFor(() => expect(texture.destroy).toHaveBeenCalledOnce());
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(f.invalidate).not.toHaveBeenCalled();
  expect(f.renderer.hasPendingResources).toBe(false);
  f.renderer.destroy();
});

function pendingEnvironment() {
  const f = fixture();
  f.composition.environment = {
    enabled: true,
    intensity: 0.45,
    rotation: 20,
    source: { name: "pending.hdr", mimeType: "image/vnd.radiance", dataUrl: "hdr:pending" },
  };
  let complete: (response: { ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    ),
  );
  const pixels = new Uint16Array(128);
  pixels.set([0x4000, 0x3c00, 0x3800, 0x3c00]);
  vi.mocked(runCpuTask).mockResolvedValue({ width: 1, height: 1, bytesPerRow: 256, pixels });
  return {
    ...f,
    complete: () => complete({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
  };
}

it("holds the first exact capture until its environment is uploaded, then uses one cached capture", async () => {
  const f = pendingEnvironment();
  const capture = vi.fn(async () => {
    f.renderer.prepare(f.composition, [f.batch], f.header);
    return f.batch.materialTexturePlan?.environmentHash;
  });
  const resources = {
    get hasPendingFrameResources() {
      return f.renderer.hasPendingResources;
    },
    waitForFrameResources: () => f.renderer.waitForFrameResources(),
  };
  const queue = new ExactFrameCaptureQueue<string | null | undefined>();
  const result = queue.capture(capture, resources);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(f.batch.materialTexturePlan?.environmentHash).toBeNull();
  f.complete();
  const hash = await result;
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(f.batch.materialTexturePlan?.environmentIntensity).toBe(0.45);
  capture.mockClear();
  await expect(queue.capture(capture, resources)).resolves.toBe(hash);
  expect(capture).toHaveBeenCalledOnce();
  f.renderer.destroy();
});

it("rejects exact captures when HDR decoding fails instead of publishing a fallback", async () => {
  const f = pendingEnvironment();
  vi.mocked(runCpuTask).mockRejectedValue(new Error("HDR decode failed"));
  f.renderer.prepare(f.composition, [f.batch], f.header);
  const waiting = f.renderer.waitForFrameResources();
  const rejected = expect(waiting).rejects.toThrow("HDR decode failed");
  f.complete();
  await rejected;
  expect(f.renderer.hasPendingResources).toBe(false);
  await expect(f.renderer.waitForFrameResources()).rejects.toThrow("HDR decode failed");
  f.renderer.destroy();
});

it("aborts material capture waits on destruction even if the source ignores cancellation", async () => {
  const f = pendingEnvironment();
  f.renderer.prepare(f.composition, [f.batch], f.header);
  const waiting = f.renderer.waitForFrameResources();
  const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  f.renderer.destroy();
  await rejected;
  await expect(f.renderer.waitForFrameResources()).rejects.toMatchObject({ name: "AbortError" });
});

it("bounds exact material waits without accepting a still-loading fallback", async () => {
  const f = pendingEnvironment();
  f.renderer.prepare(f.composition, [f.batch], f.header);
  await expect(f.renderer.waitForFrameResources(5)).rejects.toThrow(
    "Timed out waiting for exact material textures",
  );
  expect(f.renderer.hasPendingResources).toBe(true);
  f.renderer.destroy();
});

it("stops waiting for a retired environment generation whose request ignores abort", async () => {
  const f = pendingEnvironment();
  f.renderer.prepare(f.composition, [f.batch], f.header);
  const waiting = f.renderer.waitForFrameResources(100);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(1),
    })),
  );
  if (!f.composition.environment) throw new Error("Missing fixture environment");
  f.composition.environment.source.dataUrl = "hdr:replacement";
  f.renderer.prepare(f.composition, [f.batch], f.header);
  await expect(waiting).resolves.toBeUndefined();
  f.renderer.prepare(f.composition, [f.batch], f.header);
  expect(f.batch.materialTexturePlan?.environmentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(f.renderer.hasPendingResources).toBe(false);
  f.renderer.destroy();
});

it.each(["ready", "invalid"] as const)(
  "waits for normal-map GPU validation: %s",
  async (outcome) => {
    const f = fixture();
    f.layer.mesh = {
      name: "mesh",
      positions: [],
      indices: [],
      normals: [],
      uvs: [],
      materialTextures: {
        normal: { dataUrl: "normal:deferred", mimeType: "image/png", texCoord: 0, scale: 1 },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]),
      })),
    );
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
    );
    let complete: (value: GPUError | null) => void = () => {};
    f.device.popErrorScope.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    f.renderer.prepare(f.composition, [f.batch], f.header);
    let settled = false;
    const waiting = f.renderer.waitForFrameResources().finally(() => {
      settled = true;
    });
    const checked =
      outcome === "ready"
        ? expect(waiting).resolves.toBeUndefined()
        : expect(waiting).rejects.toThrow("normal upload rejected");
    await vi.waitFor(() => expect(f.device.popErrorScope).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(f.batch.materialTexturePlan?.normalHash).toBeNull();
    complete(outcome === "ready" ? null : ({ message: "normal upload rejected" } as GPUError));
    await checked;
    f.renderer.prepare(f.composition, [f.batch], f.header);
    if (outcome === "ready")
      expect(f.batch.materialTexturePlan?.normalHash).toMatch(/^[0-9a-f]{64}$/);
    else expect(f.batch.materialTexturePlan?.normalHash).toBeNull();
    f.renderer.destroy();
  },
);
