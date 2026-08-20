import { afterEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import { flattenSceneLayers } from "../core/scene-evaluation";
import { createEffect } from "../effects/registry";
import { MediaTextureCache } from "./media-texture-cache";
import { MAX_PRECOMPOSITION_SURFACE_BYTES } from "./precomposition-surface-plan";
import {
  PrecompositionSurfaceRenderer,
  precompositionSurfaceShader,
} from "./precomposition-surface-renderer";

describe("GPU precomposition surfaces", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("encodes child geometry and an isolated nested adjustment without CPU readback", () => {
    installGpuConstants();
    const events: string[] = [];
    const textures: GPUTextureDescriptor[] = [];
    const destroy = vi.fn();
    const device = mockDevice(textures, destroy);
    const layout = device.createBindGroupLayout({ entries: [] });
    const sampler = device.createSampler();
    const media = new MediaTextureCache(device, layout, sampler, vi.fn());
    const pipelines = blendPipelines();
    const renderer = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: media,
      mediaLayout: layout,
      mediaSampler: sampler,
      lightingLayout: layout,
      shapePipelines: pipelines,
      imagePipelines: pipelines,
    });

    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    nested.name = "Nested";
    const lower = nested.layers[0];
    lower.name = "Lower";
    const adjustment = createLayerForComposition("adjustment", nested);
    adjustment.effects = [createEffect("exposure")];
    const upper = createLayerForComposition("shape", nested);
    upper.name = "Upper";
    nested.layers = [upper, adjustment, lower];
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.threeDimensional = true;
    root.layers = [wrapper];
    project.compositions.push(nested);

    const frame = renderer.prepare(project, flattenSceneLayers(root, project, 0), false);
    const encoder = mockEncoder(events);
    renderer.encode(encoder);

    expect(frame).toMatchObject({ surfaceCount: 1, textureCount: 5, diagnostics: [] });
    expect(textures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: expect.stringContaining("Precomposition HDR surface"),
          format: "rgba16float",
        }),
        expect.objectContaining({
          label: expect.stringContaining("Precomposition depth surface"),
          format: "depth24plus",
        }),
      ]),
    );
    expect(events.filter((event) => event === "copy")).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        "pass:Isolated precomposition · Nested",
        "pass:Adjustment effects · Adjustment Layer",
        "pass:Resume isolated precomposition stack",
      ]),
    );
    expect("mapAsync" in device).toBe(false);

    renderer.destroy();
    expect(destroy).toHaveBeenCalled();
  });

  it("evicts time-addressed targets before resident bytes exceed the hard ceiling", () => {
    installGpuConstants();
    const textures: GPUTextureDescriptor[] = [];
    const device = mockDevice(textures, vi.fn());
    const layout = device.createBindGroupLayout({ entries: [] });
    const sampler = device.createSampler();
    const pipelines = blendPipelines();
    const renderer = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: new MediaTextureCache(device, layout, sampler, vi.fn()),
      mediaLayout: layout,
      mediaSampler: sampler,
      lightingLayout: layout,
      shapePipelines: pipelines,
      imagePipelines: pipelines,
    });
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    nested.width = 4_096;
    nested.height = 2_160;
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.threeDimensional = true;
    root.layers = [wrapper];
    project.compositions.push(nested);

    let frame = renderer.prepare(project, flattenSceneLayers(root, project, 0), false);
    const textureCountAfterWarmup = textures.length;
    for (const time of [1, 2, 3])
      frame = renderer.prepare(project, flattenSceneLayers(root, project, time), false);

    expect(frame.residentBytes).toBeLessThanOrEqual(MAX_PRECOMPOSITION_SURFACE_BYTES);
    expect(frame.residentBytes).toBe(frame.estimatedBytes);
    expect(frame.residentTextureCount).toBe(2);
    expect(textures).toHaveLength(textureCountAfterWarmup);
  });

  it("shares one bounded surface target across cloned wrapper quads", () => {
    installGpuConstants();
    const device = mockDevice([], vi.fn());
    const layout = device.createBindGroupLayout({ entries: [] });
    const sampler = device.createSampler();
    const pipelines = blendPipelines();
    const renderer = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: new MediaTextureCache(device, layout, sampler, vi.fn()),
      mediaLayout: layout,
      mediaSampler: sampler,
      lightingLayout: layout,
      shapePipelines: pipelines,
      imagePipelines: pipelines,
    });
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.threeDimensional = true;
    wrapper.cloner = {
      distribution: { kind: "grid", count: [8, 1, 1], spacing: [200, 0, 0] },
      effectors: [],
    };
    root.layers = [wrapper];
    project.compositions.push(nested);
    const scene = flattenSceneLayers(root, project, 0);

    const frame = renderer.prepare(project, scene, false);
    expect(scene).toHaveLength(8);
    expect(frame).toMatchObject({ surfaceCount: 1, textureCount: 2 });
    expect(scene.every((instance) => renderer.bindingFor(instance.instanceId))).toBe(true);
  });

  it("namespaces duplicate child media and nested surface IDs by their source sample", () => {
    installGpuConstants();
    const device = mockDevice([], vi.fn());
    const layout = device.createBindGroupLayout({ entries: [] });
    const sampler = device.createSampler();
    const media = new MediaTextureCache(device, layout, sampler, vi.fn());
    const prepareMedia = vi.spyOn(media, "prepareMedia").mockImplementation(() => undefined);
    const pipelines = blendPipelines();
    const renderer = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: media,
      mediaLayout: layout,
      mediaSampler: sampler,
      lightingLayout: layout,
      shapePipelines: pipelines,
      imagePipelines: pipelines,
    });
    const project = createBlankProject();
    const root = project.compositions[0];
    const sourceA = structuredClone(root);
    sourceA.id = crypto.randomUUID();
    sourceA.name = "Source A";
    const sourceB = structuredClone(root);
    sourceB.id = crypto.randomUUID();
    sourceB.name = "Source B";
    const leafA = structuredClone(root);
    leafA.id = crypto.randomUUID();
    leafA.name = "Leaf A";
    const leafB = structuredClone(root);
    leafB.id = crypto.randomUUID();
    leafB.name = "Leaf B";

    const duplicateMediaId = crypto.randomUUID();
    const mediaA = createLayerForComposition("image", sourceA);
    mediaA.id = duplicateMediaId;
    mediaA.asset = {
      name: "A.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,QQ==",
      width: 16,
      height: 16,
    };
    const mediaB = createLayerForComposition("image", sourceB);
    mediaB.id = duplicateMediaId;
    mediaB.asset = {
      name: "B.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,Qg==",
      width: 16,
      height: 16,
    };
    const duplicateNestedId = crypto.randomUUID();
    const nestedA = createLayerForComposition("precomposition", sourceA);
    nestedA.id = duplicateNestedId;
    nestedA.sourceCompositionId = leafA.id;
    nestedA.threeDimensional = true;
    const nestedB = createLayerForComposition("precomposition", sourceB);
    nestedB.id = duplicateNestedId;
    nestedB.sourceCompositionId = leafB.id;
    nestedB.threeDimensional = true;
    sourceA.layers = [nestedA, mediaA];
    sourceB.layers = [nestedB, mediaB];

    const wrapperA = createLayerForComposition("precomposition", root);
    wrapperA.sourceCompositionId = sourceA.id;
    wrapperA.threeDimensional = true;
    const wrapperB = createLayerForComposition("precomposition", root);
    wrapperB.sourceCompositionId = sourceB.id;
    wrapperB.threeDimensional = true;
    root.layers = [wrapperA, wrapperB];
    project.compositions.push(sourceA, sourceB, leafA, leafB);

    const frame = renderer.prepare(project, flattenSceneLayers(root, project, 0), false);
    const namespaceA = `surface:root/${wrapperA.id}`;
    const namespaceB = `surface:root/${wrapperB.id}`;
    const nestedBindingA = renderer.bindingFor(`${namespaceA}/root/${duplicateNestedId}`);
    const nestedBindingB = renderer.bindingFor(`${namespaceB}/root/${duplicateNestedId}`);
    const mediaIds = prepareMedia.mock.calls.map((call) => call[3]);

    expect(frame.surfaceCount).toBe(4);
    expect(nestedBindingA).toBeDefined();
    expect(nestedBindingB).toBeDefined();
    expect(nestedBindingA).not.toBe(nestedBindingB);
    expect(mediaIds).toEqual([
      `${namespaceA}/root/${duplicateMediaId}`,
      `${namespaceB}/root/${duplicateMediaId}`,
    ]);
  });

  it("isolates media resources for different wrapper samples of the same source", () => {
    installGpuConstants();
    const device = mockDevice([], vi.fn());
    const layout = device.createBindGroupLayout({ entries: [] });
    const sampler = device.createSampler();
    const media = new MediaTextureCache(device, layout, sampler, vi.fn());
    const prepareMedia = vi.spyOn(media, "prepareMedia").mockImplementation(() => undefined);
    const pipelines = blendPipelines();
    const renderer = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: media,
      mediaLayout: layout,
      mediaSampler: sampler,
      lightingLayout: layout,
      shapePipelines: pipelines,
      imagePipelines: pipelines,
    });
    const project = createBlankProject();
    const root = project.compositions[0];
    const source = structuredClone(root);
    source.id = crypto.randomUUID();
    const video = createLayerForComposition("video", source);
    video.asset = {
      name: "sample.mp4",
      mimeType: "video/mp4",
      runtimeUrl: "blob:sample",
      width: 16,
      height: 16,
      duration: source.duration,
    };
    source.layers = [video];
    const wrapperA = createLayerForComposition("precomposition", root);
    wrapperA.sourceCompositionId = source.id;
    wrapperA.threeDimensional = true;
    wrapperA.timeRemap = { mode: "static", value: 0 };
    const wrapperB = createLayerForComposition("precomposition", root);
    wrapperB.sourceCompositionId = source.id;
    wrapperB.threeDimensional = true;
    wrapperB.timeRemap = { mode: "static", value: 1 };
    root.layers = [wrapperA, wrapperB];
    project.compositions.push(source);

    const frame = renderer.prepare(project, flattenSceneLayers(root, project, 0), false);
    const calls = prepareMedia.mock.calls.map((call) => ({ time: call[1], id: call[3] }));

    expect(frame.surfaceCount).toBe(2);
    expect(calls).toEqual([
      { time: 0, id: `surface:root/${wrapperA.id}/root/${video.id}` },
      { time: 1, id: `surface:root/${wrapperB.id}/root/${video.id}` },
    ]);
  });

  it("keeps nested media resources stable across continuous playback samples", () => {
    installGpuConstants();
    const fetchMedia = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMedia);
    const textures: GPUTextureDescriptor[] = [];
    const device = mockDevice(textures, vi.fn());
    const layout = device.createBindGroupLayout({ entries: [] });
    const sampler = device.createSampler();
    const media = new MediaTextureCache(device, layout, sampler, vi.fn());
    const pipelines = blendPipelines();
    const renderer = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: media,
      mediaLayout: layout,
      mediaSampler: sampler,
      lightingLayout: layout,
      shapePipelines: pipelines,
      imagePipelines: pipelines,
    });
    const project = createBlankProject();
    const root = project.compositions[0];
    const source = structuredClone(root);
    source.id = crypto.randomUUID();
    const image = createLayerForComposition("image", source);
    image.asset = {
      name: "stable.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,QQ==",
      width: 16,
      height: 16,
    };
    source.layers = [image];
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = source.id;
    wrapper.threeDimensional = true;
    root.layers = [wrapper];
    project.compositions.push(source);

    const activeMediaIds: string[] = [];
    let frame = renderer.prepare(project, flattenSceneLayers(root, project, 0), true);
    const textureCountAfterWarmup = textures.length;
    activeMediaIds.push(...frame.mediaInstanceIds);
    for (const time of [1, 2, 3]) {
      frame = renderer.prepare(project, flattenSceneLayers(root, project, time), true);
      activeMediaIds.push(...frame.mediaInstanceIds);
    }

    expect(fetchMedia).toHaveBeenCalledTimes(1);
    expect(textures).toHaveLength(textureCountAfterWarmup);
    expect(new Set(activeMediaIds)).toEqual(
      new Set([`surface:root/${wrapper.id}/root/${image.id}`]),
    );
  });

  it("reports the material fidelity boundary instead of silently dropping it", () => {
    installGpuConstants();
    const device = mockDevice([], vi.fn());
    const layout = device.createBindGroupLayout({ entries: [] });
    const sampler = device.createSampler();
    const pipelines = blendPipelines();
    const renderer = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: new MediaTextureCache(device, layout, sampler, vi.fn()),
      mediaLayout: layout,
      mediaSampler: sampler,
      lightingLayout: layout,
      shapePipelines: pipelines,
      imagePipelines: pipelines,
    });
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    nested.environment = {
      enabled: true,
      intensity: 1,
      rotation: 0,
      source: {
        name: "studio.hdr",
        mimeType: "image/vnd.radiance",
        dataUrl: "data:image/vnd.radiance;base64,AA==",
      },
    };
    const mesh = createLayerForComposition("mesh", nested);
    const light = createLayerForComposition("light", nested);
    mesh.mesh = {
      name: "Mapped triangle",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      materialTextures: {
        normal: {
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,AA==",
          texCoord: 0,
        },
      },
    };
    nested.layers = [light, mesh];
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.threeDimensional = true;
    root.layers = [wrapper];
    project.compositions.push(nested);

    const frame = renderer.prepare(project, flattenSceneLayers(root, project, 0), false);
    expect(frame.diagnostics).toEqual([
      expect.stringContaining("HDR environment lighting is not sampled"),
      expect.stringContaining("mesh normal maps are not sampled"),
      expect.stringContaining("child shadow maps are not encoded"),
    ]);
    expect(precompositionSurfaceShader).toMatch(/if \(alpha <= 0\.00001\) \{ discard; \}/);
  });
});

function installGpuConstants(): void {
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
  vi.stubGlobal("GPUTextureUsage", {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    RENDER_ATTACHMENT: 8,
  });
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, UNIFORM: 2, STORAGE: 4, VERTEX: 8 });
}

function blendPipelines() {
  const pipeline = {} as GPURenderPipeline;
  return {
    normal: pipeline,
    add: pipeline,
    multiply: pipeline,
    screen: pipeline,
    overlay: pipeline,
  };
}

function mockDevice(
  textures: GPUTextureDescriptor[],
  destroy: ReturnType<typeof vi.fn>,
): GPUDevice {
  return {
    limits: { maxTextureDimension2D: 8_192 },
    queue: { writeTexture: vi.fn(), writeBuffer: vi.fn() },
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      textures.push(descriptor);
      return { createView: vi.fn(() => ({})), destroy };
    }),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createSampler: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
  } as unknown as GPUDevice;
}

function mockEncoder(events: string[]): GPUCommandEncoder {
  return {
    copyTextureToTexture: vi.fn(() => events.push("copy")),
    beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
      events.push(`pass:${descriptor.label ?? "unnamed"}`);
      return {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        draw: vi.fn(() => events.push("draw")),
        end: vi.fn(() => events.push("end")),
      };
    }),
  } as unknown as GPUCommandEncoder;
}
