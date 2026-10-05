import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import { createEffect } from "../../effects/registry";
import { prepareLayerEffect } from "../effects/layer-effect-plan";
import { LutSelectionPlanner } from "../media/lut-selection-plan";
import { encodeFramePlan } from "./codec";
import { readLayerEffectSlice } from "./layer-effect-plan";
import { buildFrameHeader } from "./root-post-plan";

export function layerEffectFixtures() {
  const composition = createBlankComposition();
  composition.width = 64;
  composition.height = 48;
  const header = buildFrameHeader({
    snapshot: { snapshotScope: "effect-fixture", projectRevision: 7 },
    compositionId: composition.id,
    time: 1 / 3,
    frameRate: composition.frameRate,
    target: { width: 64, height: 48 },
    renderTarget: { width: 64, height: 48 },
    antiAliasing: "off",
  });
  return ["identity", "custom", "pyramids", "exact-bits"].map((id) => {
    const layer = createLayerForComposition(id === "custom" ? "adjustment" : "shape", composition);
    const lut = createEffect("lut");
    lut.resource = {
      kind: "lut3d",
      name: "test.cube",
      checksum: "effect-fixture",
      size: 2,
      data: Array.from({ length: 24 }, (_, i) => i / 23),
      domainMin: [-0.25, 0, 0.125],
      domainMax: [1, 1.5, 2],
    };
    layer.effects = id === "identity" ? [] : [lut];
    if (id === "pyramids") layer.effects.push(createEffect("gaussian-blur"), createEffect("glow"));
    layer.blendMode = "soft-light";
    const prepared = prepareLayerEffect({
      header,
      composition,
      layer,
      instanceId: `effect:${id}\ud800`,
      time: 1 / 3,
      mipLevelCount: 7,
      planner: new LutSelectionPlanner(),
    });
    if (prepared.status !== "ready") throw Error("Fixture effect not ready");
    if (id === "exact-bits") {
      const bytes = prepared.plan.blobs[0];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // Unused instruction lanes must survive transport without float canonicalization.
      view.setUint32(4180, 0x80000000, true);
      view.setUint32(4184, 0x7fc01234, true);
      view.setUint32(4188, 1, true);
      view.setFloat64(4192, 1 / 3, true);
    }
    const effect = readLayerEffectSlice(prepared.plan);
    layer.effects = [];
    lut.resource.data.fill(99);
    return {
      id: `effect-${id}`,
      effect,
      prepared,
      bytes: encodeFramePlan(prepared.plan.metadata, prepared.plan.blobs),
    };
  });
}
