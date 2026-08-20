import { describe, expect, it } from "vitest";
import { compileEffectProgram } from "../renderer/effect-program";
import { createLayerForComposition } from "./layer-factory";
import { createBlankProject } from "./project";
import {
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
