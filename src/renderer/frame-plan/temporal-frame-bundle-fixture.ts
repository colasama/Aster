import { mediaFrameMessages, preparedRasterIdentity } from "../media/media-frame-identity";
import { createMediaPixelPayload } from "../media/media-pixel-payload";
import { buildTemporalTextPassPlan } from "../text/text-motion-blur-pass-plan";
import { withFrameBundleMedia } from "./frame-bundle-media";
import type { FrameBundle } from "./frame-bundle-plan";
import { buildFrameBundle } from "./frame-bundle-plan";
import { readFrameBundle } from "./frame-bundle-read";
import { buildTemporalPassSlice } from "./temporal-pass-plan";

/** Partial exposure and transparent outputs exercise nested temporal contracts through Rust. */
export function temporalFrameBundleFixture(empty: FrameBundle): FrameBundle {
  const decoded = readFrameBundle(empty),
    header = empty.plan.metadata.header;
  const messages = ["output", "sample:0", "sample:1", "transparent"].map((slot) =>
    mediaFrameMessages(
      {
        kind: "text",
        source: slot,
        textureWidth: 2,
        textureHeight: 1,
        mediaIdentity: preparedRasterIdentity("temporal-fixture", "text", slot, {
          x: 0,
          y: 0,
          width: 2,
          height: 1,
        }),
      },
      header.snapshot_scope,
    ),
  );
  const plan = buildTemporalTextPassPlan(2, 1, [0.25, 0.5], {
    hashFor: (id) => messages[id === "output" ? 0 : Number(id.slice(7)) + 1][1].hash,
  });
  const transparent = buildTemporalTextPassPlan(2, 1, [], { hashFor: () => messages[3][1].hash });
  const bundle = buildFrameBundle({
    scene: decoded.plans.scene,
    root: decoded.plans.root,
    post: decoded.plans.post,
    output: decoded.plans.output,
    shadowMapSize: decoded.shadowMapSize,
    effects: decoded.effects,
    generators: [],
    resources: messages.flat().map((message) => ({ message, bytes: new Uint8Array() })),
    temporal: [plan, transparent].map((p) => buildTemporalPassSlice(header, p)),
  });
  return withFrameBundleMedia(
    bundle,
    messages.map(([, frame], index) =>
      createMediaPixelPayload(frame, new Uint8Array([index * 20, 50, 100, 255, 40, 60, 80, 128])),
    ),
  );
}
