import { describe, expect, it } from "vitest";
import fixture from "../../examples/projects/minimal-golden.aster.json";
import fixtureRaw from "../../examples/projects/minimal-golden.aster.json?raw";
import manifest from "../../examples/projects/minimal-golden.manifest.json";
import { validateProjectDocument } from "./project-file";

describe("minimal golden project fixture", () => {
  it("is a valid current-schema project with pinned deterministic inputs", async () => {
    const project = validateProjectDocument(structuredClone(fixture));
    const composition = project.compositions[0];

    expect(project.schemaVersion).toBe(4);
    expect(project.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(project.commandLog).toEqual([]);
    expect(composition.id).toBe(project.activeCompositionId);
    expect([composition.width, composition.height]).toEqual([
      manifest.capture.width,
      manifest.capture.height,
    ]);
    expect(composition.frameRate).toEqual(manifest.capture.frameRate);
    expect(composition.layers.map((layer) => layer.kind)).toEqual(["shape", "shape"]);
    expect(composition.layers.every((layer) => layer.sourceId === undefined)).toBe(true);
    expect(project.sources).toEqual([]);
    expect(await sha256(fixtureRaw)).toBe(manifest.projectSha256);
  });

  it("addresses every requested capture by rational composition time", () => {
    const project = validateProjectDocument(structuredClone(fixture));
    const composition = project.compositions[0];
    const { numerator, denominator } = manifest.capture.frameRate;
    const captureTimes = manifest.capture.frameIndices.map(
      (frame) => (frame * denominator) / numerator,
    );

    expect(captureTimes).toEqual([0, 0.5, 1, 1.5, 119 / 60]);
    expect(captureTimes.every((time) => time >= 0 && time < composition.duration)).toBe(true);
  });
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
