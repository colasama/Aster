import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGeneratorLayerForComposition,
  createLayerForComposition,
} from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { createEffect } from "../../effects/registry";
import { MediaTextureCache } from "../media/media-texture-cache";
import type { SceneGeneratorHost } from "../scene/scene-generator-host";
import { textRasterResolutionScale } from "../text/text-rasterizer";
import {
  createPrecompositionSurfaceBudget,
  MAX_PRECOMPOSITION_SURFACE_BYTES,
  planPrecompositionSurface,
} from "./precomposition-surface-plan";
import {
  PrecompositionSurfaceRenderer,
  precompositionSurfaceShader,
} from "./precomposition-surface-renderer";
import { SurfacePostProcessing } from "./surface-post-processing";

describe("GPU precomposition surfaces", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads color and clears depth when a 2D overlay follows nested 3D geometry", () => {
    installGpuConstants();
    const device = mockDevice([], vi.fn());
    const layout = device.createBindGroupLayout({ entries: [] });
    const sampler = device.createSampler();
    const renderer = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: new MediaTextureCache(device, layout, sampler, vi.fn()),
      mediaLayout: layout,
      mediaSampler: sampler,
      lightingLayout: layout,
      shapePipelines: blendPipelines(),
      imagePipelines: blendPipelines(),
    });
    const project = createBlankProject(true);
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    const geometry = createLayerForComposition("shape", nested);
    geometry.threeDimensional = true;
    nested.layers = [createLayerForComposition("solid", nested), geometry];
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.threeDimensional = true;
    root.layers = [wrapper];
    project.compositions.push(nested);
    renderer.prepare(project, flattenSceneLayers(root, project, 0), false);
    const encoder = mockEncoder([]);
    const begin = vi.spyOn(encoder, "beginRenderPass");
    renderer.encode(encoder);
    const resumed = begin.mock.calls.find(
      ([descriptor]) => descriptor.label === "Resume isolated precomposition stack",
    )?.[0];
    expect(resumed?.depthStencilAttachment).toMatchObject({ depthLoadOp: "clear" });
    expect(Array.from(resumed?.colorAttachments ?? [])[0]).toMatchObject({ loadOp: "load" });
    renderer.destroy();
  });

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

    const project = createBlankProject(true);
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

  it("evaluates nested generators through the shared host before drawing them in stack order", () => {
    installGpuConstants();
    const events: string[] = [];
    const device = mockDevice([], vi.fn());
    const layout = device.createBindGroupLayout({ entries: [] });
    const sampler = device.createSampler();
    const pipelines = blendPipelines();
    const prepared = { instanceId: "", selectionId: "" };
    const sceneGenerators = {
      supports: vi.fn((scene) => scene.layer.kind === "generator"),
      prepare: vi.fn((scene) => ({
        ...prepared,
        instanceId: scene.instanceId,
        selectionId: scene.selectionId,
      })),
      encodeCompute: vi.fn(() => events.push("generator-compute")),
      draw: vi.fn(() => events.push("generator-draw")),
    } as unknown as SceneGeneratorHost;
    const renderer = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: new MediaTextureCache(device, layout, sampler, vi.fn()),
      mediaLayout: layout,
      mediaSampler: sampler,
      lightingLayout: layout,
      shapePipelines: pipelines,
      imagePipelines: pipelines,
      sceneGenerators,
    });
    const project = createBlankProject(true);
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    nested.name = "Generated Nested";
    const generator = createGeneratorLayerForComposition(nested, {
      pluginId: "org.example.nested-generator",
      nodeType: "nested",
      apiVersion: 1,
      parameters: { count: 64 },
    });
    generator.effects = [createEffect("exposure")];
    nested.layers = [generator];
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.threeDimensional = true;
    wrapper.timeRemap = { mode: "static", value: 2.5 };
    root.layers = [wrapper];
    project.compositions.push(nested);

    renderer.prepare(project, flattenSceneLayers(root, project, 0), false);
    renderer.encode(mockEncoder(events));

    expect(sceneGenerators.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: expect.objectContaining({ id: generator.id, kind: "generator" }),
        localTime: 2.5,
      }),
      nested,
      root.width,
      root.height,
      undefined,
      undefined,
    );
    expect(sceneGenerators.encodeCompute).toHaveBeenCalledOnce();
    expect(sceneGenerators.draw).toHaveBeenCalledOnce();
    expect(events.indexOf("generator-compute")).toBeLessThan(events.indexOf("generator-draw"));
    expect(events).toContain("pass:Layer source · Scene Generator");
    expect(events).toContain("pass:Fused layer effects · Scene Generator");
  });

  it("uses the isolated surface scale and namespaced exact-time plan for animated text", () => {
    installGpuConstants();
    const device = mockDevice([], vi.fn());
    const layout = device.createBindGroupLayout({ entries: [] });
    const sampler = device.createSampler();
    const prepareText = vi.fn();
    const media = { prepareText, prepareMedia: vi.fn() } as unknown as MediaTextureCache;
    const pipelines = blendPipelines();
    const renderer = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: media,
      mediaLayout: layout,
      mediaSampler: sampler,
      lightingLayout: layout,
      shapePipelines: pipelines,
      imagePipelines: pipelines,
    });
    const project = createBlankProject(true);
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    nested.name = "Animated text surface";
    nested.motionBlur.enabled = true;
    const text = createLayerForComposition("text", nested);
    text.motionBlur = true;
    const position = text.textAnimator?.groups[0]?.properties.position;
    if (!position) throw new Error("Expected text animator position");
    position[0] = {
      mode: "animated",
      keyframes: [
        { id: "text-open", time: 0, value: 0, interpolation: "linear" },
        { id: "text-close", time: 2, value: 240, interpolation: "linear" },
      ],
    };
    const parent = createLayerForComposition("null", nested);
    parent.transform.scale[0] = { mode: "static", value: 1200 };
    text.parentId = parent.id;
    nested.layers = [text, parent];
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.threeDimensional = true;
    root.layers = [wrapper];
    project.compositions.push(nested);
    const sceneLayers = flattenSceneLayers(root, project, 1);
    const surfacePlan = planPrecompositionSurface(
      {
        scene: sceneLayers[0],
        deviceMaxTextureDimension: device.limits.maxTextureDimension2D,
        memoryBudgetMb: 256,
        hasEffects: false,
      },
      createPrecompositionSurfaceBudget(),
    );
    if (surfacePlan.status !== "ready") throw new Error("Expected a precomposition surface");

    // This fixture isolates text raster planning; real camera/vector passes are GPU-tested.
    const postProcessing = vi.spyOn(SurfacePostProcessing, "needed").mockReturnValueOnce(false);
    renderer.prepare(project, sceneLayers, false, 256, true);
    postProcessing.mockRestore();

    expect(prepareText).toHaveBeenCalledTimes(1);
    const call = prepareText.mock.calls[0];
    expect(call[1]).toContain(`surface:root/${wrapper.id}/root/${text.id}`);
    expect(call[4]).toBeCloseTo(
      textRasterResolutionScale(
        12 * Math.max(surfacePlan.width / nested.width, surfacePlan.height / nested.height),
      ),
    );
    expect(call[5]).toMatchObject({ sampleCount: expect.any(Number) });
    expect(call[5].samples.length).toBeGreaterThan(1);
    renderer.destroy();
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
    const project = createBlankProject(true);
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
    const project = createBlankProject(true);
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
    const project = createBlankProject(true);
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
    const footageA = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "A.png",
      mimeType: "image/png",
      contentIdentity: "test:A",
      dataUrl: "data:image/png;base64,QQ==",
      width: 16,
      height: 16,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    mediaA.sourceId = footageA.id;
    const mediaB = createLayerForComposition("image", sourceB);
    mediaB.id = duplicateMediaId;
    const footageB = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "B.png",
      mimeType: "image/png",
      contentIdentity: "test:B",
      dataUrl: "data:image/png;base64,Qg==",
      width: 16,
      height: 16,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    mediaB.sourceId = footageB.id;
    project.sources.push(footageA, footageB);
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
    const mediaIds = prepareMedia.mock.calls.map((call) => call[4]);

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
    const project = createBlankProject(true);
    const root = project.compositions[0];
    const source = structuredClone(root);
    source.id = crypto.randomUUID();
    const video = createLayerForComposition("video", source);
    const footage = {
      id: crypto.randomUUID(),
      kind: "video" as const,
      name: "sample.mp4",
      mimeType: "video/mp4",
      contentIdentity: "test:video",
      runtimeUrl: "blob:sample",
      width: 16,
      height: 16,
      duration: source.duration,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    video.sourceId = footage.id;
    project.sources.push(footage);
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
    const calls = prepareMedia.mock.calls.map((call) => ({ time: call[2], id: call[4] }));

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
    const project = createBlankProject(true);
    const root = project.compositions[0];
    const source = structuredClone(root);
    source.id = crypto.randomUUID();
    const image = createLayerForComposition("image", source);
    const footage = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "stable.png",
      mimeType: "image/png",
      contentIdentity: "test:stable",
      dataUrl: "data:image/png;base64,QQ==",
      width: 16,
      height: 16,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    image.sourceId = footage.id;
    project.sources.push(footage);
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

  it("prepares child HDR lighting, normal maps and shadow targets", () => {
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
    const project = createBlankProject(true);
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

    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const frame = renderer.prepare(project, flattenSceneLayers(root, project, 0), false);
    expect(frame.diagnostics).toEqual([]);
    expect(textures.some((texture) => texture.label === "Nested composition shadow map")).toBe(
      true,
    );
    expect(precompositionSurfaceShader).toMatch(/if \(alpha <= 0\.00001\) \{ discard; \}/);
    renderer.destroy();
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
    darken: pipeline,
    lighten: pipeline,
    "color-burn": pipeline,
    "color-dodge": pipeline,
    "soft-light": pipeline,
    "hard-light": pipeline,
    difference: pipeline,
    exclusion: pipeline,
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
    beginComputePass: vi.fn((descriptor: GPUComputePassDescriptor) => {
      events.push(`compute:${descriptor.label ?? "unnamed"}`);
      return {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(() => events.push("compute-end")),
      };
    }),
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
