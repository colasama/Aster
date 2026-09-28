import { describe, expect, it } from "vitest";
import { OPERATION_TYPES } from "../core/editing/operations";
import {
  AI_COMMAND_DESCRIPTORS,
  AI_COMMAND_SCHEMA_VERSION,
  AI_COMMAND_TYPES,
  commandIndex,
  getCommandDescriptors,
  searchCommandDescriptors,
} from "./command-registry";

describe("AI command registry", () => {
  it("provides the versioned catalog for every live editor operation", () => {
    expect(AI_COMMAND_SCHEMA_VERSION).toBe(1);
    expect(new Set(AI_COMMAND_TYPES)).toEqual(new Set([...OPERATION_TYPES, "duplicateLayer"]));
    expect(AI_COMMAND_TYPES).toHaveLength(OPERATION_TYPES.length + 1);
    expect(AI_COMMAND_DESCRIPTORS.every((descriptor) => descriptor.undoable)).toBe(true);
  });

  it("discovers commands without returning the complete schema payload", () => {
    expect(searchCommandDescriptors("effect", "effects").map(({ name }) => name)).toEqual([
      "addEffect",
      "removeEffect",
      "setEffectParameter",
      "moveEffect",
      "setEffectMask",
      "toggleEffect",
      "setEffectLut",
      "setEffectParameterAtTime",
      "addEffectParameterKeyframe",
      "removeEffectParameterKeyframe",
      "moveEffectParameterKeyframe",
    ]);
    expect(JSON.stringify(getCommandDescriptors(["setSceneGenerator"]))).not.toContain("$ref");
    expect(() => getCommandDescriptors(["runShell"])).toThrow("Unknown Aster command");
    expect(() => getCommandDescriptors(["deleteLayer"])).toThrow("Did you mean");
  });

  it("ranks paraphrased agent queries that previously returned nothing", () => {
    const names = (query: string, category?: string) =>
      searchCommandDescriptors(query, category).map(({ name }) => name);
    expect(names("delete composition")[0]).toBe("removeComposition");
    expect(names("replace footage source")).toEqual(
      expect.arrayContaining(["setLayerSource", "relinkSource"]),
    );
    expect(names("layer source asset media swap")).toContain("setLayerSource");
    expect(names("video").length).toBeGreaterThan(0);
    expect(names("per character lyric animation")[0]).toBe("setTextAnimator");
    expect(names("removeComposition")[0]).toBe("removeComposition");
    expect(names("", "compositions")).toContain("removeComposition");
    expect(commandIndex().compositions).toContain("precomposeLayers");
    expect(JSON.stringify(commandIndex()).length).toBeLessThan(4096);
  });
});
