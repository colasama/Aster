import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import { createEffect } from "../../effects/registry";
import { LutSelectionPlanner, suppliedLutResource } from "../media/lut-selection-plan";
import { contentResourceHashSync } from "./resources";
import type { TexturePixelsDescriptor } from "./texture-pixels";
import type { PutResource } from "./types";

export function texturePixelFixtures() {
  const layer = createLayerForComposition("shape", createBlankComposition());
  const planner = new LutSelectionPlanner();
  const identity = suppliedLutResource(planner.prepare("lut", layer));
  const source = {
    kind: "lut3d" as const,
    name: "test.cube",
    size: 2,
    data: Array.from({ length: 24 }, (_, i) => (i - 12) / 7),
    domainMin: [0, 0, 0] as [number, number, number],
    domainMax: [1, 1, 1] as [number, number, number],
    checksum: "fixture",
  };
  const effect = createEffect("lut");
  effect.resource = source;
  layer.effects = [effect];
  const custom = suppliedLutResource(planner.prepare("lut", layer));
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
  const header = new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 1\n");
  const encoded = new Uint8Array(header.length + 8);
  encoded.set(header);
  encoded.set([128, 64, 32, 130, 32, 64, 128, 129], header.length);
  const decoded = decodeRadianceHdrForUpload(encoded);
  const hdr = prepareHdrTexture(decoded);
  decoded.pixels?.fill(0);
  fixtures.push({ id: "hdr-worker-padded", ...hdr, label: "Padded decoded HDR" });
  return fixtures;
}

import { decodeRadianceHdrForUpload } from "../../core/media/hdr-environment";
import { prepareHdrTexture } from "../media/hdr-texture-resource";
