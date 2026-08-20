import { describe, expect, it } from "vitest";
import { createBlankProject } from "./project";
import { CURRENT_PROJECT_SCHEMA_VERSION, cloneCurrentProjectDocument } from "./project-schema";

describe("MVP project schema gate", () => {
  it("clones the current schema without sharing mutable state", () => {
    const project = createBlankProject();
    const clone = cloneCurrentProjectDocument(project);
    expect(clone).toEqual(project);
    expect(clone).not.toBe(project);
    expect(clone.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
  });

  it.each([0, 2, undefined, 1.5])("rejects unsupported schema %s", (schemaVersion) => {
    expect(() => cloneCurrentProjectDocument({ schemaVersion })).toThrow(
      "this MVP accepts only v1",
    );
  });
});
