import { describe, expect, it, vi } from "vitest";
import { createBlankComposition } from "../project/project";
import { ImporterRegistry, type SourceImporter } from "./importer-registry";

describe("versioned importer registry", () => {
  it("selects the highest-scoring importer and validates before import", async () => {
    const calls: string[] = [];
    const registry = new ImporterRegistry();
    registry.register(importer("org.test.generic", 0.25, calls));
    registry.register(importer("org.test.specific", 1, calls));
    const file = new File(["pixels"], "plate.test", { type: "application/x-test" });
    const source = await registry.import(file, {
      composition: createBlankComposition(),
      currentTime: 0,
    });

    expect(source.name).toBe("org.test.specific");
    expect(calls).toEqual(["org.test.specific:validate", "org.test.specific:import"]);
  });

  it("rejects duplicate registrations, invalid probe scores, and unsupported files", async () => {
    const registry = new ImporterRegistry();
    const first = importer("org.test.first", 0, []);
    registry.register(first);
    expect(() => registry.register(first)).toThrow("already registered");
    await expect(registry.select(new File(["x"], "unknown.bin"))).rejects.toThrow(
      "No registered importer",
    );

    const invalid = importer("org.test.invalid", 2, []);
    registry.register(invalid);
    await expect(registry.select(new File(["x"], "bad.bin"))).rejects.toThrow(
      "invalid probe score",
    );
  });

  it("never calls import when validation fails", async () => {
    const registry = new ImporterRegistry();
    const importFile = vi.fn();
    registry.register({
      id: "org.test.reject",
      probe: () => 1,
      validate: () => {
        throw new Error("invalid source");
      },
      import: importFile,
    });
    await expect(
      registry.import(new File(["x"], "bad.test"), {
        composition: createBlankComposition(),
        currentTime: 0,
      }),
    ).rejects.toThrow("invalid source");
    expect(importFile).not.toHaveBeenCalled();
  });
});

function importer(id: string, score: number, calls: string[]): SourceImporter {
  return {
    id,
    probe: () => score,
    validate: () => {
      calls.push(`${id}:validate`);
    },
    import: async () => {
      calls.push(`${id}:import`);
      return {
        id: crypto.randomUUID(),
        kind: "still",
        name: id,
        mimeType: "image/png",
        contentIdentity: `test:${id}`,
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        interpretation: { alpha: "straight", colorSpace: "srgb" },
      };
    },
  };
}
