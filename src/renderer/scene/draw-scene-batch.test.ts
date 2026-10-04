import { describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import type { GeometryBatch } from "../geometry/geometry";
import { MediaBindingLease } from "../media/media-binding-lease";
import type { MediaResource } from "../media/media-resource";
import type { RendererResources } from "../renderer-resources";
import { drawSceneBatch } from "./draw-scene-batch";

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
