import { describe, expect, it } from "vitest";
import legacyFixture from "./fixtures/project-v0.json";
import { createBlankProject } from "./project";
import { validateProjectDocument } from "./project-file";
import { CURRENT_PROJECT_SCHEMA_VERSION, migrateProjectDocument } from "./project-migrations";

describe("project schema migrations", () => {
  it("migrates the immutable v0 fixture to a validated v1 document", () => {
    const original = structuredClone(legacyFixture);
    const project = validateProjectDocument(legacyFixture);

    expect(project).toMatchObject({
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      commandLog: [],
      name: "Legacy v0 fixture",
    });
    expect(legacyFixture).toEqual(original);
  });

  it("is idempotent for the current schema", () => {
    const project = createBlankProject();
    expect(migrateProjectDocument(migrateProjectDocument(project))).toEqual(project);
  });

  it("rejects future and malformed schema versions before validation", () => {
    expect(() => migrateProjectDocument({ schemaVersion: 2 })).toThrow("schema v2");
    expect(() => migrateProjectDocument({ schemaVersion: 0.5 })).toThrow("non-negative integer");
  });
});
