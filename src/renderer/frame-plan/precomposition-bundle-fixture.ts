import { createMediaPixelPayload } from "../media/media-pixel-payload";
import { encodeFramePlan } from "./codec";
import { buildPrecompositionBundle } from "./precomposition-bundle-plan";
import { precompositionGraphFixtures } from "./precomposition-graph-fixture";
import { contentResourceHashSync } from "./resources";
import type { PutResource, ResourceContent } from "./types";

export function precompositionBundleFixtures() {
  const put = (content: ResourceContent): PutResource => ({
    ...content,
    type: "put_resource",
    hash: contentResourceHashSync(content),
  });
  const source = put({
    kind: "media_source",
    descriptor: {
      source_id: "bundle/image",
      content_identity: "image-generation:7",
      authorization_scope: "bundle-fixture",
      media_kind: "image",
    },
  });
  const frame = put({
    kind: "media_frame",
    descriptor: {
      source: source.hash,
      sample: { kind: "image" },
      width: 64,
      height: 48,
      format: "rgba8unorm-srgb",
    },
  });
  return precompositionGraphFixtures(true, frame.hash).map((fixture) => {
    if (fixture.plans[0]) fixture.plans[0].label = "\0bundle\ud800";
    if (fixture.plans[1]) fixture.plans[1].label = "";
    for (const generator of fixture.plans[0]?.generators ?? []) {
      generator.origin.layerName = "nested\0label\ud800";
      generator.execution = { status: "ready", capacity: 3, effective_count: 3 };
    }
    const mediaPixels = fixture.plans.length
      ? [
          createMediaPixelPayload(
            frame,
            Uint8Array.from({ length: 64 * 48 * 4 }, (_, i) =>
              i < 4 ? [70, 80, 76, 78][i] : i % 251,
            ),
          ),
        ]
      : [];
    const bundle = buildPrecompositionBundle(fixture, fixture.plans, [source, frame], mediaPixels);
    return {
      id: `${fixture.id}-bundle`,
      bundle,
      mediaPixels,
      plans: fixture.plans,
      bytes: encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs),
    };
  });
}
