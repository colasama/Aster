import { requirePlan } from "./canonical";
import { mediaResourceFixtures } from "./media-resource-fixture";
import { createRasterPixels } from "./raster-resource";

export async function rasterPixelFixtures() {
  const messages = await mediaResourceFixtures();
  const fixtures = [];
  for (const frame of messages) {
    if (frame.kind !== "media_frame" || frame.descriptor.sample.kind !== "raster") continue;
    const source = messages.find((m) => m.hash === frame.descriptor.source);
    requirePlan(source?.kind === "media_source", "missing_resource", "Fixture source is absent");
    const bytes = Uint8Array.from(
      { length: frame.descriptor.width * frame.descriptor.height * 4 },
      (_, i) => (i * 29 + Math.floor(i / 4)) % 256,
    );
    fixtures.push({ source, frame, ...(await createRasterPixels(frame, bytes)) });
  }
  return fixtures;
}
