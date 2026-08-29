import { describe, expect, it } from "vitest";
import { compileEffectProgram } from "../renderer/effect-program";
import { createLayerForComposition } from "./layer-factory";
import { createBlankProject } from "./project";
import {
  projectDocumentForPersistence,
  readRecoverySnapshot,
  serializeProject,
  storeRecoverySnapshot,
  validateProjectDocument,
} from "./project-file";

describe("project compatibility fallbacks", () => {
  it("preserves a missing plugin effect while rendering it as a no-op", () => {
    const project = createBlankProject();
    project.compositions[0].layers[0].effects.push({
      id: "missing-effect",
      type: "org.example.missing-effect",
      name: "Unavailable effect",
      enabled: true,
      parameters: { amount: 0.75 },
    });

    const restored = validateProjectDocument(JSON.parse(serializeProject(project)));
    const effect = restored.compositions[0].layers[0].effects[0];
    expect(effect).toMatchObject({
      type: "org.example.missing-effect",
      parameters: { amount: 0.75 },
    });
    expect(compileEffectProgram(restored.compositions[0]).count).toBe(0);
  });

  it("keeps missing media as a relinkable placeholder", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const image = createLayerForComposition("image", composition);
    const source = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "missing-plate.png",
      mimeType: "image/png",
      contentIdentity: "test:missing",
      width: 2048,
      height: 1152,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    image.sourceId = source.id;
    project.sources.push(source);
    composition.layers.push(image);

    const restored = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(restored.compositions[0].layers[1].sourceId).toBe(source.id);
    expect(restored.sources[0]).toEqual(source);
  });

  it("persists relative asset paths without ephemeral protocol URLs", () => {
    const project = createBlankProject();
    const image = createLayerForComposition("image", project.compositions[0]);
    const source = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "plate.png",
      mimeType: "image/png",
      contentIdentity: "test:linked",
      width: 1920,
      height: 1080,
      relativePath: "assets/plate.png",
      runtimeUrl: "asset://localhost/plate.png",
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    image.sourceId = source.id;
    project.sources.push(source);
    project.compositions[0].layers.push(image);

    const persisted = projectDocumentForPersistence(project);
    expect(persisted.sources[0]).toMatchObject({
      relativePath: "assets/plate.png",
    });
    expect(persisted.sources[0].runtimeUrl).toBeUndefined();
    expect(project.sources[0].runtimeUrl).toContain("asset:");
  });

  it("rejects relative asset traversal before native resolution", () => {
    const project = createBlankProject();
    const image = createLayerForComposition("image", project.compositions[0]);
    const source = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "secret.png",
      mimeType: "image/png",
      contentIdentity: "test:traversal",
      width: 1,
      height: 1,
      relativePath: "../secret.png",
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    image.sourceId = source.id;
    project.sources.push(source);
    project.compositions[0].layers.push(image);
    expect(() => validateProjectDocument(project)).toThrow("stay inside the project bundle");
  });

  it("discards a corrupted recovery snapshot without replacing the project", () => {
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    };
    storeRecoverySnapshot(createBlankProject(), storage);
    const recoveryKey = [...entries.keys()][0];
    entries.set(recoveryKey, "{ truncated project");

    expect(readRecoverySnapshot(storage)).toBeUndefined();
    expect(entries.has(recoveryKey)).toBe(false);
  });
});
