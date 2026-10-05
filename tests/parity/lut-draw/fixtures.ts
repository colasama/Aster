import { createLayerForComposition } from "../../../src/core/layers/layer-factory";
import { float32ToFloat16 } from "../../../src/core/media/half-float";
import { createBlankComposition } from "../../../src/core/project/project";
import { createEffect } from "../../../src/effects/registry";
import { contentResourceHashSync } from "../../../src/renderer/frame-plan/resources";
import { buildFrameHeader } from "../../../src/renderer/frame-plan/root-post-plan";
import type { PutResource } from "../../../src/renderer/frame-plan/types";

export function lutDrawFixtures() {
  const composition = createBlankComposition();
  composition.width = 64;
  composition.height = 48;
  const header = buildFrameHeader({
    snapshot: { snapshotScope: "lut-draw", projectRevision: 1 },
    compositionId: composition.id,
    time: 0.375,
    frameRate: composition.frameRate,
    target: { width: 64, height: 48 },
    renderTarget: { width: 64, height: 48 },
    antiAliasing: "off",
  });
  const bytes = new Uint8Array(64 * 48 * 8);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 64; x++) {
      const alpha = x < 8 ? 0 : 0.75;
      const rgba = [(alpha * x) / 32, (alpha * y) / 24, (alpha * ((x + y) % 16)) / 12, alpha];
      rgba.forEach((v, i) => {
        view.setUint16((y * 64 + x) * 8 + i * 2, float32ToFloat16(v), true);
      });
    }
  const content = {
    kind: "texture_pixels" as const,
    descriptor: {
      dimension: "2d" as const,
      width: 64,
      height: 48,
      depth: 1,
      format: "rgba16float" as const,
    },
  };
  const message: PutResource = {
    type: "put_resource",
    ...content,
    hash: contentResourceHashSync(content, bytes),
  };
  const cases = ["identity", "custom", "adjustment", "blur", "glow", "blend"].map((id) => {
    const layer = createLayerForComposition(
      id === "adjustment" ? "adjustment" : "shape",
      composition,
    );
    const lut = createEffect("lut");
    lut.resource = {
      kind: "lut3d",
      name: "swap.cube",
      checksum: "lut-draw-swap",
      size: 2,
      data: Array.from({ length: 8 }, (_, i) => [
        0.1 + ((i >> 2) & 1) * 0.6,
        0.15 + (i & 1) * 0.7,
        0.05 + ((i >> 1) & 1) * 0.8,
      ]).flat(),
      domainMin: [-0.125, 0, 0.125],
      domainMax: [1.5, 1.25, 1],
    };
    layer.effects = id === "identity" ? [] : [lut];
    if (id === "blur") layer.effects.push(createEffect("gaussian-blur"));
    if (id === "glow") layer.effects.push(createEffect("glow"));
    if (id === "blend") layer.blendMode = "soft-light";
    return { id, layer };
  });
  return { composition, header, cases, source: { message, bytes } };
}
