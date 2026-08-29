import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultCameraSettings, evaluateCameraSettings } from "../core/camera-settings";
import { createGeneratorLayerForComposition } from "../core/layer-factory";
import type { PluginManifest, PluginStatus } from "../core/plugins";
import { createBlankProject } from "../core/project";
import { flattenSceneLayers } from "../core/scene-evaluation";
import {
  createSceneGeneratorInstance,
  getSceneGeneratorDefinitions,
  synchronizeSceneGeneratorDefinitions,
} from "../core/scene-generator-registry";
import type { SceneCamera } from "./geometry";
import { SceneGeneratorHost } from "./scene-generator-host";

const manifest: PluginManifest = {
  plugin: {
    id: "org.example.scene.points",
    name: "Third-party Points",
    version: "1.2.3",
    api_version: 1,
    shader: "simulate.wgsl",
    kind: "scene_generator",
  },
  capabilities: ["gpu_compute", "gpu_render"],
  parameters: [
    { type: "number", name: "count", label: "Count", default: 128, min: 1, max: 4_096 },
    {
      type: "choice",
      name: "mode",
      label: "Mode",
      default: "quad",
      choices: ["quad", "mesh"],
    },
    { type: "vector", name: "offset", label: "Offset", default: [0, 0, 0], min: -10, max: 10 },
  ],
  scene_generator: {
    api_version: 1,
    node_type: "points",
    capacity_parameter: "count",
    max_instances: 4_096,
    instance_stride: 16,
    render_parameter: "mode",
    compute_passes: [
      {
        id: "simulate",
        shader: "simulate.wgsl",
        entry_point: "simulate",
        workgroup_size: [64, 1, 1],
        phase: "simulation",
      },
      {
        id: "compact",
        shader: "compact.wgsl",
        entry_point: "compact",
        workgroup_size: [32, 1, 1],
        phase: "pre_render",
      },
    ],
    render_variants: [
      {
        id: "quad",
        shader: "render.wgsl",
        vertex_entry: "quad_vertex",
        fragment_entry: "quad_fragment",
        vertex_count: 6,
        selector_value: "quad",
        blend: "layer",
        depth: "none",
        cull: "none",
        auxiliary: {
          shader: "render.wgsl",
          vertex_entry: "quad_vertex",
          fragment_entry: "quad_auxiliary",
        },
      },
      {
        id: "mesh",
        shader: "render.wgsl",
        vertex_entry: "mesh_vertex",
        fragment_entry: "mesh_fragment",
        vertex_count: 12,
        selector_value: "mesh",
        blend: "add",
        depth: "read",
        cull: "back",
      },
    ],
  },
};

const sources = {
  "simulate.wgsl": "simulate source",
  "compact.wgsl": "compact source",
  "render.wgsl": "render source",
};

interface FakeBuffer {
  label: string;
  size: number;
  destroy: ReturnType<typeof vi.fn>;
}

interface BufferWrite {
  buffer: FakeBuffer;
  data: ArrayBuffer;
}

interface FakeGpu {
  device: GPUDevice;
  buffers: FakeBuffer[];
  writes: BufferWrite[];
  createComputePipeline: ReturnType<typeof vi.fn>;
  createRenderPipeline: ReturnType<typeof vi.fn>;
  createShaderModule: ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1, VERTEX: 2, FRAGMENT: 4 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, INDIRECT: 4, UNIFORM: 8 });
});

afterEach(() => {
  synchronizeSceneGeneratorDefinitions(status([]));
  vi.unstubAllGlobals();
});

describe("third-party scene generator host integration", () => {
  it("runs discovery, typed packing, isolated resources, ordered compute, indirect draw, and MRT", () => {
    expect(synchronizeSceneGeneratorDefinitions(status([manifest]))).toEqual([]);
    const definition = getSceneGeneratorDefinitions()[0];
    const project = createBlankProject();
    const composition = project.compositions[0];
    const instance = createSceneGeneratorInstance(definition);
    instance.parameters.count = 1_500;
    instance.parameters.mode = "quad";
    instance.parameters.offset = [2, 3, 4];
    const layer = createGeneratorLayerForComposition(composition, instance);
    layer.blendMode = "screen";
    layer.timeOffset = 2;
    layer.timeStretch = 2;
    layer.cloner = {
      distribution: { kind: "grid", count: [2, 1, 1], spacing: [120, 0, 0] },
      effectors: [],
    };
    composition.layers = [layer];
    const [scene, clone] = flattenSceneLayers(composition, project, 6);
    expect(scene.instanceId).not.toBe(clone.instanceId);
    expect(scene.transform.position).not.toEqual(clone.transform.position);
    const gpu = fakeGpu();
    const host = new SceneGeneratorHost(gpu.device, "rgba16float");
    const camera = sceneCamera();

    host.beginFrame();
    const first = host.prepare(scene, composition, 960, 540, undefined, camera);
    const second = host.prepare(clone, composition, 960, 540, undefined, camera);
    if (!first || !second) throw new Error("Expected both generator instances to prepare");

    expect(first.requestedCount).toBe(1_500);
    expect(first.effectiveCount).toBe(1_500);
    expect(first.resources.capacity).toBe(2_048);
    expect(first.resources.storage).not.toBe(second.resources.storage);
    expect(gpu.createShaderModule).toHaveBeenCalledTimes(3);
    expect(gpu.createComputePipeline).toHaveBeenCalledTimes(2);
    expect(gpu.createRenderPipeline).toHaveBeenCalledTimes(7);

    const contextWrite = gpu.writes.find(
      (write) => write.buffer === (first.resources.context as unknown as FakeBuffer),
    );
    const parameterWrite = gpu.writes.find(
      (write) => write.buffer === (first.resources.parameters as unknown as FakeBuffer),
    );
    const indirectWrite = gpu.writes.find(
      (write) => write.buffer === (first.resources.indirect as unknown as FakeBuffer),
    );
    if (!contextWrite || !parameterWrite || !indirectWrite)
      throw new Error("Expected standard ABI buffer writes");
    expect([...new Float32Array(contextWrite.data).slice(0, 4)]).toEqual([960, 540, 6, 5]);
    expect([...new Float32Array(contextWrite.data).slice(20, 23)]).toEqual([10, 20, 30]);
    expect([...new Float32Array(contextWrite.data).slice(24, 27)]).toEqual([4, 5, 6]);
    expect(new Float32Array(contextWrite.data)[28]).toBe(1);
    const cloneContextWrite = gpu.writes.find(
      (write) => write.buffer === (second.resources.context as unknown as FakeBuffer),
    );
    if (!cloneContextWrite) throw new Error("Expected clone context buffer write");
    expect([...new Float32Array(cloneContextWrite.data).slice(8, 11)]).not.toEqual([
      ...new Float32Array(contextWrite.data).slice(8, 11),
    ]);
    const packed = new Float32Array(parameterWrite.data);
    expect(packed[0]).toBe(1_500);
    expect(packed[4]).toBe(0);
    expect([...packed.slice(8, 11)]).toEqual([2, 3, 4]);
    expect([...new Uint32Array(indirectWrite.data)]).toEqual([6, 0, 0, 0]);

    const compute = fakeComputePass();
    host.encodeCompute(compute.pass, first);
    expect(compute.dispatches).toEqual([
      [24, 1, 1],
      [47, 1, 1],
    ]);
    const render = fakeRenderPass();
    host.draw(render.pass, first);
    expect(render.pipelines[0]?.label).toContain("quad · screen");
    expect(render.indirectBuffers).toEqual([first.resources.indirect]);
    expect(host.auxiliaryDraw(first)).toMatchObject({
      bindGroup: first.resources.renderBindGroup,
      indirectBuffer: first.resources.indirect,
    });
    expect(host.estimatedBytes).toBeGreaterThan(2 * 2_048 * 16);
  });

  it("isolates missing plugins and destroys resources that leave the evaluated scene", () => {
    synchronizeSceneGeneratorDefinitions(status([manifest]));
    const definition = getSceneGeneratorDefinitions()[0];
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = createGeneratorLayerForComposition(
      composition,
      createSceneGeneratorInstance(definition),
    );
    layer.cloner = {
      distribution: { kind: "grid", count: [2, 1, 1], spacing: [120, 0, 0] },
      effectors: [],
    };
    composition.layers = [layer];
    const [scene, clone] = flattenSceneLayers(composition, project, 0);
    const gpu = fakeGpu();
    const host = new SceneGeneratorHost(gpu.device, "rgba16float");

    host.beginFrame();
    const first = host.prepare(scene, composition, 640, 360);
    const second = host.prepare(clone, composition, 640, 360);
    if (!first || !second) throw new Error("Expected generator resources");
    host.sweep();

    host.beginFrame();
    expect(host.prepare(scene, composition, 640, 360)).toBeDefined();
    host.sweep();
    expect((second.resources.storage as unknown as FakeBuffer).destroy).toHaveBeenCalledOnce();

    synchronizeSceneGeneratorDefinitions(status([]));
    host.beginFrame();
    expect(host.prepare(scene, composition, 640, 360)).toBeUndefined();
    expect(host.diagnostics).toEqual([
      expect.stringContaining(
        "Missing or disabled scene generator org.example.scene.points:points",
      ),
    ]);
    host.sweep();
    expect((first.resources.storage as unknown as FakeBuffer).destroy).toHaveBeenCalledOnce();
  });

  it("retains unaffected resources and replaces only executable definitions that change", () => {
    synchronizeSceneGeneratorDefinitions(status([manifest]));
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = createGeneratorLayerForComposition(
      composition,
      createSceneGeneratorInstance(getSceneGeneratorDefinitions()[0]),
    );
    composition.layers = [layer];
    const scene = flattenSceneLayers(composition, project, 0)[0];
    const gpu = fakeGpu();
    const host = new SceneGeneratorHost(gpu.device, "rgba16float");

    host.beginFrame();
    const initial = host.prepare(scene, composition, 640, 360);
    if (!initial) throw new Error("Expected initial generator resources");
    host.sweep();

    const unrelated = structuredClone(manifest);
    unrelated.plugin.id = "org.example.scene.unrelated";
    unrelated.plugin.name = "Unrelated Generator";
    synchronizeSceneGeneratorDefinitions(status([manifest, unrelated]));
    host.beginFrame();
    const retained = host.prepare(scene, composition, 640, 360);
    if (!retained) throw new Error("Expected retained generator resources");
    expect(retained.resources).toBe(initial.resources);
    expect((initial.resources.storage as unknown as FakeBuffer).destroy).not.toHaveBeenCalled();
    host.sweep();

    const changed = status([manifest, unrelated]);
    if (!changed.report.shader_sources) throw new Error("Expected shader sources fixture");
    changed.report.shader_sources[manifest.plugin.id] = {
      ...sources,
      "simulate.wgsl": "updated simulate source",
    };
    synchronizeSceneGeneratorDefinitions(changed);
    host.beginFrame();
    const replaced = host.prepare(scene, composition, 640, 360);
    if (!replaced) throw new Error("Expected reloaded generator resources");
    expect(replaced.resources).not.toBe(initial.resources);
    expect((initial.resources.storage as unknown as FakeBuffer).destroy).toHaveBeenCalledOnce();
  });

  it("keeps beauty rendering available when the adapter cannot expose the auxiliary MRT", () => {
    synchronizeSceneGeneratorDefinitions(status([manifest]));
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = createGeneratorLayerForComposition(
      composition,
      createSceneGeneratorInstance(getSceneGeneratorDefinitions()[0]),
    );
    composition.layers = [layer];
    const scene = flattenSceneLayers(composition, project, 0)[0];
    const gpu = fakeGpu(false);
    const host = new SceneGeneratorHost(gpu.device, "rgba16float");

    host.beginFrame();
    const prepared = host.prepare(scene, composition, 640, 360);
    if (!prepared) throw new Error("Expected beauty-only generator resources");
    expect(gpu.createRenderPipeline).toHaveBeenCalledTimes(6);
    expect(host.auxiliaryDraw(prepared)).toBeUndefined();
  });
});

function sceneCamera(): SceneCamera {
  const settings = createDefaultCameraSettings(1920, 1080);
  settings.mode = "oneNode";
  settings.projection = "orthographic";
  settings.orthographicSize = { mode: "static", value: 720 };
  const transform = {
    position: [10, 20, 30] as [number, number, number],
    rotation: [4, 5, 6] as [number, number, number],
    scale: [100, 100, 100] as [number, number, number],
    anchor: [0, 0, 0] as [number, number, number],
    opacity: 1,
  };
  return {
    transform,
    settings,
    ...evaluateCameraSettings(settings, transform, 0, 1920),
  };
}

function status(plugins: PluginManifest[]): PluginStatus {
  return {
    directory: "plugins",
    safeMode: false,
    disabled: [],
    report: {
      plugins,
      failures: [],
      shader_sources: Object.fromEntries(
        plugins.map((plugin) => [plugin.plugin.id, structuredClone(sources)]),
      ),
    },
    hotReload: {
      enabled: false,
      suspendedBySafeMode: false,
      pending: false,
      revision: 0,
      successfulReloads: 0,
      rejectedReloads: 0,
      diagnostics: [],
    },
    native: true,
  };
}

function fakeGpu(auxiliarySupported = true): FakeGpu {
  const buffers: FakeBuffer[] = [];
  const writes: BufferWrite[] = [];
  const createComputePipeline = vi.fn((descriptor: GPUComputePipelineDescriptor) => ({
    descriptor,
    label: descriptor.label,
  }));
  const createRenderPipeline = vi.fn((descriptor: GPURenderPipelineDescriptor) => ({
    descriptor,
    label: descriptor.label,
  }));
  const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => ({
    descriptor,
    label: descriptor.label,
  }));
  const device = {
    limits: {
      maxStorageBufferBindingSize: 512 * 1024 * 1024,
      maxBufferSize: 512 * 1024 * 1024,
      maxComputeWorkgroupsPerDimension: 65_535,
      maxColorAttachments: auxiliarySupported ? 8 : 4,
      maxColorAttachmentBytesPerSample: auxiliarySupported ? 32 : 16,
    },
    queue: {
      writeBuffer: (buffer: FakeBuffer, _offset: number, data: AllowSharedBufferSource) => {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        writes.push({ buffer, data: bytes.slice().buffer });
      },
    },
    createBindGroupLayout: vi.fn((descriptor) => ({ descriptor })),
    createPipelineLayout: vi.fn((descriptor) => ({ descriptor })),
    createShaderModule,
    createComputePipeline,
    createRenderPipeline,
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = {
        label: String(descriptor.label),
        size: Number(descriptor.size),
        destroy: vi.fn(),
      };
      buffers.push(buffer);
      return buffer;
    }),
    createBindGroup: vi.fn((descriptor) => ({ descriptor })),
  } as unknown as GPUDevice;
  return {
    device,
    buffers,
    writes,
    createComputePipeline,
    createRenderPipeline,
    createShaderModule,
  };
}

function fakeComputePass(): {
  pass: GPUComputePassEncoder;
  dispatches: Array<[number, number, number]>;
} {
  const dispatches: Array<[number, number, number]> = [];
  return {
    pass: {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: (x: number, y: number, z: number) => dispatches.push([x, y, z]),
    } as unknown as GPUComputePassEncoder,
    dispatches,
  };
}

function fakeRenderPass(): {
  pass: GPURenderPassEncoder;
  pipelines: Array<{ label?: string }>;
  indirectBuffers: GPUBuffer[];
} {
  const pipelines: Array<{ label?: string }> = [];
  const indirectBuffers: GPUBuffer[] = [];
  return {
    pass: {
      setPipeline: (pipeline: { label?: string }) => pipelines.push(pipeline),
      setBindGroup: vi.fn(),
      drawIndirect: (buffer: GPUBuffer) => indirectBuffers.push(buffer),
    } as unknown as GPURenderPassEncoder,
    pipelines,
    indirectBuffers,
  };
}
