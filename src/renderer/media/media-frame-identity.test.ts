import { expect, it } from "vitest";
import { rasterSample } from "../frame-plan/raster-sample";
import { contentResourceHashSync } from "../frame-plan/resources";
import { mediaFrameMessages, preparedRasterIdentity } from "./media-frame-identity";
import type { MediaResource } from "./media-resource";

it("isolates cached identities and invalidates nested source, sample, scope and extent changes", () => {
  const identity = preparedRasterIdentity("raster\ud800", "text", "generation", {
    x: 0,
    y: 0,
    width: 2,
    height: 2,
  });
  const resource: MediaResource = {
    kind: "text",
    source: "raster",
    textureWidth: 2,
    textureHeight: 2,
    mediaIdentity: identity,
  };
  const initial = mediaFrameMessages(resource, "scope");
  const returned = mediaFrameMessages(resource, "scope");
  if (returned[0].kind !== "media_source" || returned[1].kind !== "media_frame")
    throw Error("Wrong media descriptors");
  returned[0].descriptor.content_identity = "poison";
  returned[1].descriptor.width = 99;
  if (returned[1].descriptor.sample.kind !== "raster") throw Error("Expected raster sample");
  returned[1].descriptor.sample.bounds_f64_le[0] = 1;
  expect(mediaFrameMessages(resource, "scope")).toEqual(initial);
  identity.source.content_identity = "replacement";
  const changed = mediaFrameMessages(resource, "scope");
  expect(changed[0].hash).not.toBe(initial[0].hash);
  expect(changed[1].hash).not.toBe(initial[1].hash);
  if (typeof identity.source.source_id === "string") throw Error("Expected UTF-16 identity");
  identity.source.source_id.utf16_units[0] = 65;
  const renamed = mediaFrameMessages(resource, "scope");
  expect(renamed[0].hash).not.toBe(changed[0].hash);
  identity.sample = rasterSample("text", { x: 1, y: 0, width: 2, height: 2 });
  const moved = mediaFrameMessages(resource, "scope");
  expect(moved[0].hash).toBe(renamed[0].hash);
  expect(moved[1].hash).not.toBe(renamed[1].hash);
  if (identity.sample.kind !== "raster") throw Error("Expected raster sample");
  identity.sample.bounds_f64_le[0] = 1;
  const resampled = mediaFrameMessages(resource, "scope");
  expect(resampled[1].hash).not.toBe(moved[1].hash);
  resource.textureWidth = 3;
  expect(mediaFrameMessages(resource, "scope")[1].hash).not.toBe(moved[1].hash);
  const scoped = mediaFrameMessages(resource, "another-scope");
  expect(scoped[0].hash).not.toBe(moved[0].hash);
  for (const messages of [initial, changed, renamed, moved, resampled, scoped])
    for (const message of messages) expect(message.hash).toBe(contentResourceHashSync(message));
  Object.assign(identity.source, { unexpected: true });
  expect(() => mediaFrameMessages(resource, "another-scope")).toThrow();
});

it("reuses video source identity while keeping exact requested and uploaded clocks", () => {
  const resource: MediaResource = {
    kind: "video",
    source: "video",
    textureWidth: 2,
    textureHeight: 2,
    mediaIdentity: {
      source: { source_id: "video", content_identity: "sha256:video", media_kind: "video" },
      sample: { kind: "image" },
    },
    nativeVideoPlan: true,
    lastUploadedTime: 0,
  };
  const first = mediaFrameMessages(resource, "scope", 0);
  const sought = mediaFrameMessages(resource, "scope", 1 / 30);
  expect(sought[0]).toEqual(first[0]);
  expect(sought[1].hash).not.toBe(first[1].hash);
  resource.lastUploadedTime = 1 / 30;
  const uploaded = mediaFrameMessages(resource, "scope", 1 / 30);
  expect(uploaded[1].hash).not.toBe(sought[1].hash);
  expect(uploaded[1].hash).toBe(contentResourceHashSync(uploaded[1]));
  resource.lastUploadedTime = undefined;
  expect(() => mediaFrameMessages(resource, "scope", 1 / 30)).toThrow(/missing/);
  resource.nativeVideoPlan = false;
  expect(mediaFrameMessages(resource, "scope", 1 / 30)[0].hash).not.toBe(first[0].hash);
});
