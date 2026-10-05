import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import { BLEND_MODES } from "../../core/types";
import { createEffect } from "../../effects/registry";
import { prepareLayerEffect } from "../effects/layer-effect-plan";
import { LutSelectionPlanner } from "../media/lut-selection-plan";
import { encodeFramePlan } from "./codec";
import { readEffectExecutionSlice } from "./effect-execution-plan";
import { buildFrameHeader } from "./root-post-plan";

export function effectExecutionFixtures() {
  const composition = createBlankComposition();
  const header = buildFrameHeader({
    snapshot: { snapshotScope: "effect-execution", projectRevision: 1 },
    compositionId: composition.id,
    time: 0,
    frameRate: composition.frameRate,
    target: { width: 64, height: 48 },
    renderTarget: { width: 64, height: 48 },
    antiAliasing: "off",
  });
  return [
    ...BLEND_MODES,
    "direct",
    "root-skip",
    "precomposition-noop",
    "overflow",
    "disabled",
    "failed-lut",
  ].map((id) => {
    const layer = createLayerForComposition(
      ["root-skip", "precomposition-noop", "failed-lut"].includes(id) ? "adjustment" : "shape",
      composition,
    );
    layer.id = `layer:${id}\ud800`;
    layer.effects = [createEffect("exposure")];
    if (BLEND_MODES.includes(id as (typeof BLEND_MODES)[number]))
      layer.blendMode = id as (typeof BLEND_MODES)[number];
    if (["direct", "root-skip", "precomposition-noop"].includes(id)) layer.effects = [];
    if (id === "precomposition-noop") layer.blendMode = "multiply";
    if (id === "disabled") layer.effects[0].enabled = false;
    if (id === "overflow")
      layer.effects = Array.from({ length: 70 }, () => createEffect("exposure"));
    if (id === "failed-lut") {
      const lut = createEffect("lut");
      lut.resource = {
        kind: "lut3d",
        name: "invalid",
        checksum: "invalid",
        size: 2,
        data: [0],
        domainMin: [0, 0, 0],
        domainMax: [1, 1, 1],
      };
      layer.effects = [lut];
    }
    const prepared = prepareLayerEffect({
      composition,
      header,
      layer,
      instanceId: `instance:${id}\ud800`,
      time: 0,
      mipLevelCount: 6,
      planner: new LutSelectionPlanner(),
      context: id === "precomposition-noop" ? "precomposition" : "root",
    });
    const execution = readEffectExecutionSlice(prepared.execution);
    layer.effects = [];
    layer.blendMode = "normal";
    return {
      id: `execution-${id}`,
      execution,
      prepared,
      bytes: encodeFramePlan(prepared.execution.metadata, prepared.execution.blobs),
    };
  });
}
