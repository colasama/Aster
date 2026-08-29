import { describe, expect, it } from "vitest";
import { createDefaultParticleSettings } from "./particle-settings";
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
    expect(() => cloneCurrentProjectDocument({ schemaVersion: 0 })).toThrow(
      "migration is registered from v0 to v1",
    );
  });

  it("migrates v1 documents to the current schema", () => {
    const legacy = createBlankProject() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    const layer = (legacy.compositions as Array<{ layers: Array<Record<string, unknown>> }>)[0]
      .layers[0];
    layer.kind = "particle";
    layer.particle = createDefaultParticleSettings();
    const migrated = cloneCurrentProjectDocument(legacy) as {
      schemaVersion: number;
      compositions: Array<{ layers: Array<Record<string, unknown>> }>;
    };
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.compositions[0].layers[0]).toMatchObject({
      kind: "generator",
      generator: { pluginId: "org.aster.builtin.particles", nodeType: "particle_system" },
    });
    expect(migrated.compositions[0].layers[0].particle).toBeUndefined();
  });

  it("validates the legacy particle contract before wrapping it as a plugin instance", () => {
    const legacy = createBlankProject() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    const layer = (legacy.compositions as Array<{ layers: Array<Record<string, unknown>> }>)[0]
      .layers[0];
    layer.kind = "particle";
    layer.particle = { ...createDefaultParticleSettings(), count: 1_000_001 };
    expect(() => cloneCurrentProjectDocument(legacy)).toThrow(
      "legacy particle settings.count must be between 1 and 1000000",
    );
  });

  it("migrates v2 documents to v3 without rewriting existing layers", () => {
    const previous = createBlankProject() as unknown as Record<string, unknown>;
    previous.schemaVersion = 2;
    const migrated = cloneCurrentProjectDocument(previous);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.compositions).toEqual(previous.compositions);
  });

  it.each([4, undefined, 1.5])("rejects unsupported schema %s", (schemaVersion) => {
    expect(() => cloneCurrentProjectDocument({ schemaVersion })).toThrow("Aster project schema");
  });
});
