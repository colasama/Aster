import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest, PluginStatus } from "./plugins";

const mocks = vi.hoisted(() => ({
  loadPluginRuntime: vi.fn(),
  synchronizeEffects: vi.fn((_status: unknown) => []),
  synchronizeGenerators: vi.fn((_status: unknown) => []),
}));

vi.mock("./plugins", () => ({ loadPluginRuntime: mocks.loadPluginRuntime }));
vi.mock("../../effects/plugin-registry", () => ({
  synchronizePluginEffectDefinitions: mocks.synchronizeEffects,
}));
vi.mock("../scene/scene-generator-registry", () => ({
  synchronizeSceneGeneratorDefinitions: mocks.synchronizeGenerators,
}));

const effectManifest: PluginManifest = {
  plugin: {
    id: "org.example.effect",
    name: "Example effect",
    version: "1.0.0",
    api_version: 1,
    shader: "effect.wgsl",
    kind: "effect",
  },
  capabilities: ["gpu_render"],
  parameters: [],
};

describe("plugin runtime activation", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.loadPluginRuntime.mockReset();
    mocks.synchronizeEffects.mockClear();
    mocks.synchronizeGenerators.mockClear();
  });

  it("loads and registers only explicitly requested plugin payloads", async () => {
    mocks.loadPluginRuntime.mockResolvedValue(
      status([effectManifest], {
        [effectManifest.plugin.id]: { "effect.wgsl": "shader" },
      }),
    );
    const runtime = await import("./plugin-runtime");

    await runtime.activatePluginRuntimes([effectManifest.plugin.id]);

    expect(mocks.loadPluginRuntime).toHaveBeenCalledWith([effectManifest.plugin.id]);
    expect(runtime.getLoadedPluginIds()).toEqual(new Set([effectManifest.plugin.id]));
    const synchronizedStatus = mocks.synchronizeEffects.mock.calls[0]?.[0] as
      | PluginStatus
      | undefined;
    expect(synchronizedStatus?.report.plugins).toEqual([effectManifest]);
  });

  it("does not load anything for an empty default project", async () => {
    const runtime = await import("./plugin-runtime");

    await runtime.setProjectPluginRuntimes([]);

    expect(mocks.loadPluginRuntime).not.toHaveBeenCalled();
    expect(runtime.getLoadedPluginIds().size).toBe(0);
  });
});

function status(
  plugins: PluginManifest[],
  shaderSources: Record<string, Record<string, string>>,
): PluginStatus {
  return {
    directory: "plugins",
    safeMode: false,
    disabled: [],
    report: { plugins, failures: [], shader_sources: shaderSources },
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
