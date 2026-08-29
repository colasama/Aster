import { describe, expect, it } from "vitest";
import { createBlankProject } from "./project";
import { CURRENT_PROJECT_SCHEMA_VERSION, cloneCurrentProjectDocument } from "./project-schema";

describe("project schema migration gate", () => {
  it("clones the current schema without sharing mutable state", () => {
    const project = createBlankProject();
    const clone = cloneCurrentProjectDocument(project);
    expect(clone).toEqual(project);
    expect(clone).not.toBe(project);
    expect(clone.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
  });

  it("rejects a historical schema without a registered migration", () => {
    const source = { schemaVersion: 0, name: "legacy" };
    expect(() => cloneCurrentProjectDocument(source)).toThrow(
      "migration is registered from v0 to v1",
    );
    expect(source).toEqual({ schemaVersion: 0, name: "legacy" });
  });

  it.each([2, undefined, 1.5])("rejects unsupported schema %s", (schemaVersion) => {
    expect(() => cloneCurrentProjectDocument({ schemaVersion })).toThrow("Aster project schema");
  });
});
