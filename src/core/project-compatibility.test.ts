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
    image.asset = {
      name: "missing-plate.png",
      mimeType: "image/png",
      width: 2048,
      height: 1152,
    };
    composition.layers.push(image);

    const restored = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(restored.compositions[0].layers[1].asset).toEqual(image.asset);
  });

  it("persists relative asset paths without ephemeral protocol URLs", () => {
    const project = createBlankProject();
    const image = createLayerForComposition("image", project.compositions[0]);
    image.asset = {
      name: "plate.png",
      mimeType: "image/png",
      width: 1920,
      height: 1080,
      relativePath: "assets/plate.png",
      runtimeUrl: "asset://localhost/plate.png",
    };
    project.compositions[0].layers.push(image);

    const persisted = projectDocumentForPersistence(project);
    expect(persisted.compositions[0].layers[1].asset).toMatchObject({
      relativePath: "assets/plate.png",
    });
    expect(persisted.compositions[0].layers[1].asset?.runtimeUrl).toBeUndefined();
    expect(project.compositions[0].layers[1].asset?.runtimeUrl).toContain("asset:");
  });

  it("rejects relative asset traversal before native resolution", () => {
    const project = createBlankProject();
    const image = createLayerForComposition("image", project.compositions[0]);
    image.asset = {
      name: "secret.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      relativePath: "../secret.png",
    };
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
