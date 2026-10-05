import { describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import type { GeometryBatch } from "../geometry/geometry";
import { MediaBindingLease } from "../media/media-binding-lease";
import type { MediaResource } from "../media/media-resource";
import type { RendererResources } from "../renderer-resources";
import { drawPlannedSceneBatch } from "./draw-planned-scene-batch";
import { drawSceneBatch } from "./draw-scene-batch";
import { planSceneDraw, type SceneDrawPlan } from "./scene-draw-plan";

describe("content-addressed media drawing", () => {
  it("uses the supplied hash independently of instance IDs and fails before drawing absent resources", () => {
    const binding = {} as GPUBindGroup;
    const owner: MediaResource = {
      source: "asset",
      kind: "image",
      bindGroup: binding,
      textureWidth: 16,
      textureHeight: 16,
      mediaIdentity: {
        source: { source_id: "asset", content_identity: "asset-v1", media_kind: "image" },
        sample: { kind: "image" },
      },
    };
    const lease = new MediaBindingLease(
      [{ instanceId: "prepared", resource: owner, binding }],
      "snapshot",
    );
    const batch: GeometryBatch = {
      layer: createLayerForComposition("image", createBlankComposition()),
      instanceId: "draw",
      resourceInstanceId: "different",
      selectionId: "draw",
      firstVertex: 3,
      vertexCount: 6,
      mediaResourceHash: lease.hashFor("prepared"),
    };
    const pass = {
      setVertexBuffer: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    const resources = {
      shapeBuffer: {},
      imagePipelines: { normal: {} },
      mediaTextures: {
        bindGroup: vi.fn(() => {
          throw Error("Unexpected hidden lookup");
        }),
      },
    } as unknown as RendererResources;
    drawSceneBatch(resources, pass, batch, lease, "normal");
    expect(pass.setBindGroup).toHaveBeenCalledWith(0, binding);
    expect(pass.draw).toHaveBeenCalledExactlyOnceWith(6, 1, 3);
    batch.mediaResourceHash = "0".repeat(64);
    expect(() => drawSceneBatch(resources, pass, batch, lease, "normal")).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
    expect(pass.draw).toHaveBeenCalledTimes(1);
    lease.release();
    expect(() => lease.bindingForHash(lease.hashFor("prepared"))).toThrow();
  });
});

describe("planned scene drawing", () => {
  function harness() {
    const pass = {
      setVertexBuffer: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    const surface = {} as GPUBindGroup;
    const raster = {} as GPUBindGroup;
    const material = { pipeline: {}, bindGroup: {} };
    const resources = {
      shapeBuffer: {},
      lightingBindGroup: {},
      shapePipelines: { screen: {} },
      imagePipelines: { screen: {} },
      precompositionSurfaces: {
        bindingFor: vi.fn<(id: string) => GPUBindGroup | undefined>(() => surface),
        pipelineFor: vi.fn(() => ({})),
      },
      mediaTextures: { bindGroup: vi.fn(() => raster) },
      materialTextures: {
        bindingFor: vi.fn<() => typeof material | undefined>(() => material),
      },
    };
    const draw: SceneDrawPlan = {
      instanceId: "draw",
      firstVertex: 7,
      vertexCount: 12,
      blendMode: "screen",
      texture: { kind: "none" },
    };
    const lease = new MediaBindingLease([]);
    const execute = () =>
      drawPlannedSceneBatch(resources as unknown as RendererResources, pass, draw, lease);
    return { pass, resources, draw, lease, surface, raster, material, execute };
  }

  it("owns the prepared ranges and material values, and submitted ranges follow the supplied plan", () => {
    const layer = createLayerForComposition("shape", createBlankComposition());
    layer.blendMode = "screen";
    const batch: GeometryBatch = {
      layer,
      instanceId: "draw",
      resourceInstanceId: "source",
      selectionId: "selection",
      firstVertex: 7,
      vertexCount: 12,
      materialTexturePlan: {
        instanceId: "material",
        active: true,
        normalEnabled: true,
        normalScale: -2,
        environmentIntensity: 0,
        environmentRotation: 0,
        normalHash: "a".repeat(64),
        environmentHash: null,
      },
    };
    const plan = structuredClone(planSceneDraw(batch));
    layer.kind = "precomposition";
    layer.blendMode = "multiply";
    batch.vertexCount = 99;
    if (batch.materialTexturePlan) batch.materialTexturePlan.normalScale = 8;
    const h = harness();
    drawPlannedSceneBatch(h.resources as unknown as RendererResources, h.pass, plan, h.lease);
    expect(h.pass.draw).toHaveBeenLastCalledWith(12, 1, 7);
    expect(h.resources.materialTextures.bindingFor).toHaveBeenLastCalledWith(
      expect.objectContaining({ normalScale: -2 }),
      "screen",
    );
    expect(h.resources.precompositionSurfaces.bindingFor).not.toHaveBeenCalled();
    plan.vertexCount = 3;
    plan.firstVertex = 19;
    drawPlannedSceneBatch(h.resources as unknown as RendererResources, h.pass, plan, h.lease);
    expect(h.pass.draw).toHaveBeenLastCalledWith(3, 1, 19);
    h.lease.release();
  });

  it("omits an unavailable surface and gives a ready surface precedence over material", () => {
    const h = harness();
    h.draw.texture = { kind: "surface", instanceId: "nested" };
    h.resources.precompositionSurfaces.bindingFor.mockReturnValueOnce(undefined);
    h.execute();
    expect(h.pass.draw).not.toHaveBeenCalled();
    h.execute();
    expect(h.resources.precompositionSurfaces.bindingFor).toHaveBeenLastCalledWith("nested");
    expect(h.pass.setBindGroup).toHaveBeenLastCalledWith(0, h.surface);
    expect(h.resources.materialTextures.bindingFor).not.toHaveBeenCalled();
    h.lease.release();
  });

  it("preserves material, raster, then shape fallback priority and explicit pending media", () => {
    const h = harness();
    h.draw.texture = { kind: "media", hash: "a".repeat(64) };
    vi.spyOn(h.lease, "bindingForHash").mockImplementation((hash) =>
      hash === null ? undefined : h.raster,
    );
    h.execute();
    expect(h.pass.setPipeline).toHaveBeenLastCalledWith(h.material.pipeline);
    expect(h.lease.bindingForHash).toHaveBeenLastCalledWith("a".repeat(64));
    expect(h.resources.mediaTextures.bindGroup).not.toHaveBeenCalled();
    h.resources.materialTextures.bindingFor.mockReturnValue(undefined);
    h.execute();
    expect(h.pass.setPipeline).toHaveBeenLastCalledWith(h.resources.imagePipelines.screen);
    h.draw.texture = { kind: "media", hash: null };
    h.resources.mediaTextures.bindGroup.mockClear();
    h.execute();
    expect(h.pass.setPipeline).toHaveBeenLastCalledWith(h.resources.shapePipelines.screen);
    expect(h.resources.mediaTextures.bindGroup).not.toHaveBeenCalled();
    h.lease.release();
  });
});
