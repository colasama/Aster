import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import { runCpuTask } from "../../core/scheduling/cpu-scheduler";
import type { GeometryBatch } from "../geometry/geometry";
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
  return { device, renderer, composition, layer, batch, invalidate };
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
  f.renderer.prepare(f.composition, [f.batch]);
  const pending = structuredClone(f.batch.materialTexturePlan);
  await vi.waitFor(() => expect(f.renderer.hasPendingResources).toBe(false));
  expect(f.renderer.bindingFor(pending, "normal")).toBeUndefined();
  f.renderer.prepare(f.composition, [f.batch]);
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
  f.renderer.prepare(f.composition, []);
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
  f.renderer.prepare(f.composition, [f.batch]);
  await vi.waitFor(() => expect(f.renderer.hasPendingResources).toBe(false));
  f.renderer.prepare(f.composition, [f.batch, second]);
  await vi.waitFor(() => expect(f.renderer.hasPendingResources).toBe(false));
  f.renderer.prepare(f.composition, [f.batch, second]);
  expect(f.batch.materialTexturePlan?.normalHash).toBe(second.materialTexturePlan?.normalHash);
  if (!second.materialTexturePlan) throw Error("Material plan missing");
  const supplied = { ...second.materialTexturePlan, instanceId: "independent-wire-instance" };
  expect(f.renderer.bindingFor(supplied, "normal")).toBeDefined();
  const before = f.device.createBindGroup.mock.calls.length;
  const firstTexture = f.device.createTexture.mock.results[0].value;
  const secondTexture = f.device.createTexture.mock.results[1].value;
  f.renderer.prepare(f.composition, [second]);
  expect(firstTexture.destroy).toHaveBeenCalledOnce();
  expect(f.renderer.bindingFor(supplied, "normal")).toBeDefined();
  expect(f.device.createBindGroup).toHaveBeenCalledTimes(before + 1);
  expect(secondTexture.createView).toHaveBeenCalledOnce();
  f.renderer.prepare(f.composition, []);
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
  f.renderer.prepare(f.composition, [f.batch]);
  await vi.waitFor(() => expect(f.device.popErrorScope).toHaveBeenCalledOnce());
  const texture = f.device.createTexture.mock.results[0].value;
  f.renderer.prepare(f.composition, []);
  complete(null);
  await vi.waitFor(() => expect(texture.destroy).toHaveBeenCalledOnce());
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(f.invalidate).not.toHaveBeenCalled();
  expect(f.renderer.hasPendingResources).toBe(false);
  f.renderer.destroy();
});
