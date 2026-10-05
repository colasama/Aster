import { prepareLutTexture } from "../media/lut-texture";
import { contentResourceHashSync } from "./resources";
import type { TexturePixelsDescriptor } from "./texture-pixels";
import type { PutResource } from "./types";

export function texturePixelFixtures() {
  const identity = prepareLutTexture();
  const source = {
    kind: "lut3d" as const,
    name: "test.cube",
    size: 2,
    data: Array.from({ length: 24 }, (_, i) => (i - 12) / 7),
    domainMin: [0, 0, 0] as [number, number, number],
    domainMax: [1, 1, 1] as [number, number, number],
    checksum: "fixture",
  };
  const custom = prepareLutTexture(source);
  source.data.fill(99);
  const fixtures = [
    { id: "lut-identity", ...identity },
    { id: "lut-custom", ...custom },
  ];
  for (const format of ["rgba8unorm", "rgba16float"] as const) {
    const bytes =
      format === "rgba8unorm"
        ? new Uint8Array([128, 128, 255, 255, 0, 128, 128, 255])
        : new Uint8Array([0, 64, 0, 60, 0, 56, 0, 60, 0, 48, 0, 52, 0, 56, 0, 60]);
    const descriptor: TexturePixelsDescriptor = {
      dimension: "2d",
      width: 2,
      height: 1,
      depth: 1,
      format,
    };
    const content = { kind: "texture_pixels" as const, descriptor };
    const message: PutResource = {
      type: "put_resource",
      ...content,
      hash: contentResourceHashSync(content, bytes),
    };
    fixtures.push({ id: format, message, bytes, label: format });
  }
  return fixtures;
}
