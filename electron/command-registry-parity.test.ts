import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import registry from "../schemas/ai-commands.v1.json";
import { OPERATION_TYPES } from "../src/core/operations";

describe("AI command registry parity", () => {
  it("keeps TypeScript operations, Pi schemas, and documentation on registry v1", () => {
    const documentation = readFileSync(resolve("docs/AI_OPERATIONS.md"), "utf8");
    expect(registry.schemaVersion).toBe(1);
    expect(new Set(registry.commands.map(({ name }) => name))).toEqual(new Set(OPERATION_TYPES));
    for (const command of registry.commands) {
      expect(documentation).toContain(`| \`${command.name}\` |`);
      expect(command.version).toBe(1);
    }
  });
});
