import { requirePlan } from "../frame-plan/canonical";
import type { readFrameBundle } from "../frame-plan/frame-bundle-read";
import { readRootScenePlan } from "../frame-plan/root-scene-plan";
import { readTemporalPassSlice } from "../frame-plan/temporal-pass-plan";
import { uploadEncodedTexture } from "../media/encoded-texture-upload";
import { MaterialGpuBindings } from "../media/material-gpu-bindings";
import { SuppliedMediaPixels } from "../media/supplied-media-pixels";
import { uploadTexturePixels } from "../media/texture-pixel-upload";
import type { RendererResources } from "../renderer-resources";
import { SuppliedTemporalTextPasses } from "../text/supplied-temporal-text-passes";

/** A frame owns its installed texture generations until submission and readback complete. */
export class SuppliedFrameAssets {
  readonly materials: MaterialGpuBindings;
  media?: SuppliedMediaPixels;
  temporal?: SuppliedTemporalTextPasses;
  readonly #textures: GPUTexture[] = [];

  private constructor(resources: RendererResources) {
    this.materials = new MaterialGpuBindings(
      resources.device,
      "rgba16float",
      resources.lightingBindGroupLayout,
    );
  }

  static async create(
    decoded: ReturnType<typeof readFrameBundle>,
    resources: RendererResources,
  ): Promise<SuppliedFrameAssets> {
    const result = new SuppliedFrameAssets(resources),
      device = resources.device;
    try {
      result.media = await SuppliedMediaPixels.create(
        decoded.mediaPixels,
        decoded.mediaFrames.map((frame) => frame.hash),
        {
          device,
          label: "Supplied frame media",
          maximumDimension: device.limits.maxTextureDimension2D,
          maximumBytes: 64 * 1024 * 1024,
          createBindGroup: (texture) =>
            device.createBindGroup({
              layout: resources.imageBindGroupLayout,
              entries: [
                { binding: 0, resource: texture.createView() },
                { binding: 1, resource: resources.imageSampler },
              ],
            }),
        },
        decoded.plans.temporal.map((slice) => readTemporalPassSlice(slice).output),
      );
      result.temporal = new SuppliedTemporalTextPasses(
        decoded.plans.temporal,
        device,
        resources.imageSampler,
        result.media,
      );
      const packets = new Map(
        decoded.materialPackets.map((packet) => [packet.message.hash, packet]),
      );
      const installed = new Set<string>();
      for (const { material } of readRootScenePlan(decoded.plans.root).draws) {
        for (const [role, hash] of [
          ["normal", material?.normalHash],
          ["environment", material?.environmentHash],
        ] as const) {
          if (!hash || installed.has(`${role}:${hash}`)) continue;
          const packet = packets.get(hash);
          requirePlan(packet, "missing_resource", "Supplied material texture is absent");
          requirePlan(
            role === "normal"
              ? packet.message.kind === "encoded_texture"
              : packet.message.kind === "texture_pixels",
            "invalid_resource",
            "Supplied material role differs from payload",
          );
          const texture =
            role === "normal"
              ? (
                  await uploadEncodedTexture(
                    device,
                    packet.message,
                    packet.bytes,
                    "Supplied normal texture",
                  )
                ).texture
              : uploadTexturePixels(
                  device,
                  packet.message,
                  packet.bytes,
                  "Supplied HDR environment",
                );
          result.#textures.push(texture);
          result.materials.register(hash, role, texture);
          installed.add(`${role}:${hash}`);
        }
      }
      return result;
    } catch (error) {
      result.destroy();
      throw error;
    }
  }

  destroy(): void {
    this.temporal?.destroy();
    this.media?.destroy();
    this.materials.destroy();
    for (const texture of this.#textures) texture.destroy();
    this.#textures.length = 0;
  }
}
