import { expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import { createEffect } from "../../effects/registry";
import { LutSelectionPlanner, suppliedLutResource } from "./lut-selection-plan";

function lutEffect(checksum: string, value: number) {
  const effect = createEffect("lut");
  effect.resource = {
    kind: "lut3d",
    name: checksum,
    checksum,
    size: 2,
    data: Array(24).fill(value),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
  };
  return effect;
}

it("selects the last enabled loaded LUT and owns its pixels independently of authoring", () => {
  const layer = createLayerForComposition("shape", createBlankComposition());
  const planner = new LutSelectionPlanner();
  const first = lutEffect("first", 0.25);
  const selected = lutEffect("selected", 0.75);
  const disabled = lutEffect("disabled", 0);
  disabled.enabled = false;
  layer.effects = [first, selected, createEffect("lut"), disabled];
  const prepared = planner.prepare("instance", layer);
  const bytes = suppliedLutResource(prepared).bytes.slice();
  selected.resource?.data.fill(0);
  expect(planner.prepare("instance", layer)).toBe(prepared);
  expect(suppliedLutResource(structuredClone(prepared)).bytes).toEqual(bytes);
  if (!selected.resource) throw Error("Missing fixture resource");
  selected.resource.checksum = "changed";
  expect(suppliedLutResource(planner.prepare("instance", layer)).bytes).not.toEqual(bytes);
  layer.effects = [];
  expect(suppliedLutResource(planner.prepare("instance", layer))).toBe(planner.identity);
});

it("releases cached source selections on sweep and defers malformed LUT diagnostics", () => {
  const layer = createLayerForComposition("shape", createBlankComposition());
  const planner = new LutSelectionPlanner();
  const effect = lutEffect("retained", 0.5);
  layer.effects = [effect];
  const prepared = planner.prepare("instance", layer);
  planner.sweep(new Set());
  expect(planner.prepare("instance", layer)).not.toBe(prepared);
  if (!effect.resource) throw Error("Missing fixture resource");
  effect.resource.checksum = "malformed";
  effect.resource.data = [0, 0];
  const failure = planner.prepare("instance", layer);
  expect(failure.status).toBe("failed");
  expect(() => suppliedLutResource(failure)).toThrow("RGB triplets");
  expect(() => suppliedLutResource(undefined)).toThrow("Missing prepared LUT selection");
});
