import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifest, PluginStatus } from "../core/plugins/plugins";
import {
  getPluginEffectDefinitions,
  pluginManifestToEffectDefinition,
  synchronizePluginEffectDefinitions,
} from "./plugin-registry";
import { createEffect, EFFECT_BY_TYPE, effectCategories } from "./registry";

const manifest: PluginManifest = {
  plugin: {
    id: "org.aster.example.inspector",
    name: "Inspector Example",
    version: "1.0.0",
    api_version: 1,
    shader: "effect.wgsl",
  },
  capabilities: ["gpu_render"],
  parameters: [
    { type: "number", name: "amount", label: "Amount", default: 0.5, min: 0, max: 1 },
    { type: "color", name: "tint", label: "Tint", default: [0.25, 0.5, 1, 1] },
    {
      type: "choice",
      name: "mode",
      label: "Mode",
      default: "Screen",
      choices: ["Normal", "Screen"],
    },
    { type: "texture", name: "source", label: "Source" },
  ],
};

afterEach(() => synchronizePluginEffectDefinitions(status([])));

describe("plugin effect registry", () => {
  it("maps every manifest parameter kind into Inspector definitions", () => {
    const definition = pluginManifestToEffectDefinition(manifest);

    expect(definition.parameters).toEqual([
      {
        key: "amount",
        label: "Amount",
        kind: "number",
        defaultValue: 0.5,
        min: 0,
        max: 1,
        step: 0.01,
      },
      { key: "tint", label: "Tint", kind: "color", defaultValue: 0x4080ff },
      {
        key: "mode",
        label: "Mode",
        kind: "choice",
        defaultValue: 1,
        min: 0,
        max: 1,
        step: 1,
        options: ["Normal", "Screen"],
      },
      { key: "source", label: "Source", kind: "texture", defaultValue: 0 },
    ]);
  });

  it("registers enabled plugins for creation and removes disabled plugins", () => {
    expect(synchronizePluginEffectDefinitions(status([manifest]))).toEqual([]);
    expect(EFFECT_BY_TYPE.get(manifest.plugin.id)?.category).toBe("Plugins");
    expect(EFFECT_BY_TYPE.get(manifest.plugin.id)).toBe(getPluginEffectDefinitions()[0]);
    expect(effectCategories()).toContain("Plugins");
    expect(createEffect(manifest.plugin.id).parameters).toEqual({
      amount: 0.5,
      tint: 0x4080ff,
      mode: 1,
      source: 0,
    });

    synchronizePluginEffectDefinitions(status([manifest], [manifest.plugin.id]));
    expect(getPluginEffectDefinitions()).toEqual([]);
    expect(EFFECT_BY_TYPE.has(manifest.plugin.id)).toBe(false);
  });

  it("isolates unsafe parameter schemas instead of exposing them to the UI", () => {
    const invalid: PluginManifest = {
      ...manifest,
      parameters: [{ type: "number", name: "amount", label: "Amount", default: 2, min: 0, max: 1 }],
    };

    const failures = synchronizePluginEffectDefinitions(status([invalid]));
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("invalid range");
    expect(getPluginEffectDefinitions()).toEqual([]);
    expect(EFFECT_BY_TYPE.has(manifest.plugin.id)).toBe(false);
  });

  it("keeps only one effect when discovery returns duplicate plugin ids", () => {
    const failures = synchronizePluginEffectDefinitions(status([manifest, manifest]));
    expect(failures[0].message).toContain("installed more than once");
    expect(getPluginEffectDefinitions()).toHaveLength(1);
  });

  it("hides every plugin while safe mode is enabled", () => {
    synchronizePluginEffectDefinitions({ ...status([manifest]), safeMode: true });
    expect(getPluginEffectDefinitions()).toEqual([]);
  });
});

function status(plugins: PluginManifest[], disabled: string[] = []): PluginStatus {
  return {
    directory: "plugins",
    safeMode: false,
    disabled,
    report: { plugins, failures: [] },
    hotReload: {
      enabled: false,
      suspendedBySafeMode: false,
      pending: false,
      revision: 0,
      successfulReloads: 0,
      rejectedReloads: 0,
      diagnostics: [],
    },
    native: true,
  };
}
