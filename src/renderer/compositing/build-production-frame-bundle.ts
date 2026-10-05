import { buildFrameBundle, type FrameBundleInput } from "../frame-plan/frame-bundle-plan";
import type { MediaBindingLease } from "../media/media-binding-lease";
import type { RendererResources } from "../renderer-resources";
import type { PreparedSceneGenerator } from "../scene/scene-generator-host";
import type { PrecompositionScenePlan } from "./precomposition-scene-plan";

/** Collect only resource packets already realized for the selected frame. */
export function buildProductionFrameBundle(
  input: Omit<FrameBundleInput, "resources" | "precompositions" | "generators"> & {
    resources: RendererResources;
    mediaBindings: MediaBindingLease;
    surfaces: readonly PrecompositionScenePlan[];
    generators: readonly PreparedSceneGenerator[];
  },
) {
  const mediaPackets = input.mediaBindings.resourceMessages.map((message) => ({
    message,
    bytes: new Uint8Array(),
  }));
  const mediaHashes = new Set(mediaPackets.map((packet) => packet.message.hash));
  const materialHashes = input.root.metadata.resources.filter((hash) => !mediaHashes.has(hash));
  return buildFrameBundle({
    ...input,
    temporal: input.resources.mediaTextures.planTemporalPasses(
      input.post.metadata.header,
      input.mediaBindings,
    ),
    generators: input.generators.map((generator) => ({
      plan: generator.plan,
      capacity: generator.resources.capacity,
    })),
    precompositions: input.resources.precompositionSurfaces.serializeScenes(
      input.surfaces,
      input.mediaBindings,
    ),
    resources: [
      ...mediaPackets,
      ...(input.resources.materialTextures?.resourcePackets(materialHashes) ?? []),
    ],
  });
}
