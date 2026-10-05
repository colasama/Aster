import { describe, expect, it } from "vitest";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { recordRootSceneExecution, rootSceneFixtures } from "./root-scene-fixture";
import { readRootScenePlan } from "./root-scene-plan";

describe("root command transport", () => {
  it("preserves supplied draws, resources, UTF-16 identities and binary64 clears", () => {
    for (const fixture of rootSceneFixtures()) {
      const plan = decodeFramePlan(fixture.bytes);
      const root = readRootScenePlan(plan);
      expect(root).toEqual(fixture.root);
      expect(encodeFramePlan(plan.metadata, plan.blobs)).toEqual(fixture.bytes);
      expect(recordRootSceneExecution(root)).toEqual(recordRootSceneExecution(fixture.root));
      const command = root.commands[0];
      if (command.kind !== "begin_scene") throw Error("Missing first pass");
      expect(Object.is(command.color.clearValue[0], -0)).toBe(true);
      expect(command.color.clearValue[1]).toBe(Number.MIN_VALUE);
      if (root.draws.length) {
        const before = recordRootSceneExecution(root);
        root.commands = root.commands.filter((c) => !(c.kind === "geometry" && c.drawIndex === 0));
        expect(recordRootSceneExecution(root)).not.toEqual(before);
      }
    }
  });

  it("rejects invalid pass order, references, blends and nonfinite clear payloads", () => {
    const fixture = rootSceneFixtures()[1];
    for (const mutation of [
      "end",
      "draw",
      "blend",
      "effect",
      "material",
      "resource",
      "clear",
    ] as const) {
      const plan = decodeFramePlan(fixture.bytes);
      const root = plan.metadata.slices[0];
      if (root.kind !== "root_scene_commands") throw Error("Wrong slice");
      if (mutation === "end") root.commands.pop();
      if (mutation === "draw") {
        const draw = root.commands.find((c) => c.kind === "geometry");
        if (draw?.kind === "geometry") draw.draw_index = 999;
      }
      if (mutation === "blend") {
        const draw = root.commands.find((c) => c.kind === "geometry");
        if (draw?.kind === "geometry") draw.blend_mode = "multiply";
      }
      if (mutation === "effect") {
        const command = root.commands.find((c) => c.kind === "begin_layer");
        if (command?.kind === "begin_layer") command.effect_blob_index = 1;
      }
      if (mutation === "material") root.draws[0].material_blob_index = 0;
      if (mutation === "resource") plan.metadata.resources = [];
      if (mutation === "clear") {
        const blob = plan.blobs[0];
        new DataView(blob.buffer, blob.byteOffset, blob.byteLength).setFloat64(0, Number.NaN, true);
      }
      expect(() => readRootScenePlan(plan), mutation).toThrow();
    }
  });
});
