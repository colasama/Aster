import { rasterSample } from "./raster-sample";
import { contentResourceHash } from "./resources";
import { frameTimeFromNumber } from "./time";
import type { PutResource, ResourceContent } from "./types";

export async function mediaResourceFixtures(): Promise<PutResource[]> {
  const messages: PutResource[] = [];
  async function put(content: ResourceContent): Promise<PutResource> {
    const message = {
      ...content,
      type: "put_resource" as const,
      hash: await contentResourceHash(content),
    };
    messages.push(message);
    return message;
  }
  for (const media_kind of ["image", "sequence", "video"] as const) {
    const source = await put({
      kind: "media_source",
      descriptor: {
        source_id: `媒体/${media_kind}/🎬`,
        content_identity: `opaque-import:${media_kind}`,
        authorization_scope: "render-job:test",
        media_kind,
      },
    });
    const samples =
      media_kind === "image"
        ? [{ kind: "image" as const }]
        : media_kind === "sequence"
          ? [-1, 0, 9007199254740991].map((frame) => ({
              kind: "sequence" as const,
              frame,
              file_identity: `member:${frame}`,
            }))
          : [-0, 1001 / 24000, 1001 / 30000, 0.1 + Number.EPSILON].map((time) => ({
              kind: "video" as const,
              requested_time: frameTimeFromNumber(time),
              uploaded_time: frameTimeFromNumber(time + 0.0001),
            }));
    for (const sample of samples)
      await put({
        kind: "media_frame",
        descriptor: {
          source: source.hash,
          sample,
          width: 1920,
          height: 1080,
          format: "rgba8unorm-srgb",
        },
      });
  }
  for (const origin of ["text", "svg", "psd"] as const) {
    const source = await put({
      kind: "media_source",
      descriptor: {
        source_id: `raster/${origin}`,
        content_identity: `${origin}:font-or-source-generation:17`,
        authorization_scope: "render-job:test",
        media_kind: "raster",
      },
    });
    await put({
      kind: "media_frame",
      descriptor: {
        source: source.hash,
        sample: rasterSample(origin, { x: -0, y: -12.25, width: Math.PI, height: 45.5 }),
        width: 64,
        height: 64,
        format: "rgba8unorm-srgb",
      },
    });
  }
  const image = messages.find(
    (message) => message.kind === "media_frame" && message.descriptor.sample.kind === "image",
  );
  if (image?.kind === "media_frame")
    await put({ kind: "media_frame", descriptor: { ...image.descriptor, format: "rgba16float" } });
  return messages;
}
