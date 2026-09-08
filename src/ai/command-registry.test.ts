import { describe, expect, it } from "vitest";
import { OPERATION_TYPES } from "../core/editing/operations";
import {
  AI_COMMAND_DESCRIPTORS,
  AI_COMMAND_SCHEMA_VERSION,
  AI_COMMAND_TYPES,
  getCommandDescriptors,
  searchCommandDescriptors,
} from "./command-registry";

describe("AI command registry", () => {
  it("provides the versioned catalog for every live editor operation", () => {
    expect(AI_COMMAND_SCHEMA_VERSION).toBe(1);
    expect(new Set(AI_COMMAND_TYPES)).toEqual(new Set(OPERATION_TYPES));
    expect(AI_COMMAND_TYPES).toHaveLength(OPERATION_TYPES.length);
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
  });
});
