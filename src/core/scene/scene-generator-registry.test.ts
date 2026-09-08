import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifest, PluginStatus } from "../plugins/plugins";
import {
  createSceneGeneratorInstance,
  getSceneGeneratorDefinitions,
  getSceneGeneratorRegistryRevision,
  sceneGeneratorDefinitionFromManifest,
  synchronizeSceneGeneratorDefinitions,
} from "./scene-generator-registry";

const manifest: PluginManifest = {
  plugin: {
    id: "org.aster.example.points",
    name: "Points",
    version: "1.0.0",
    api_version: 1,
    shader: "compute.wgsl",
    kind: "scene_generator",
  },
  capabilities: ["gpu_compute", "gpu_render"],
  parameters: [
    { type: "number", name: "count", label: "Count", default: 100, min: 1, max: 1_000 },
    { type: "vector", name: "offset", label: "Offset", default: [0, 0, 0], min: -1, max: 1 },
  ],
  scene_generator: {
    api_version: 1,
    node_type: "points",
    capacity_parameter: "count",
    max_instances: 1_000,
    instance_stride: 16,
    compute_passes: [
      {
        id: "generate",
        shader: "compute.wgsl",
        entry_point: "compute_main",
        workgroup_size: [64, 1, 1],
        phase: "simulation",
      },
    ],
    render_variants: [
      {
        id: "points",
        shader: "render.wgsl",
        vertex_entry: "vertex_main",
        fragment_entry: "fragment_main",
        vertex_count: 6,
        blend: "add",
        depth: "none",
        cull: "none",
      },
    ],
  },
};

const sources = { "compute.wgsl": "compute", "render.wgsl": "render" };

afterEach(() => synchronizeSceneGeneratorDefinitions(status([])));

describe("scene generator plugin registry", () => {
  it("projects a validated manifest into a serializable generator instance", () => {
    const definition = sceneGeneratorDefinitionFromManifest(manifest, sources);
    expect(createSceneGeneratorInstance(definition)).toEqual({
      pluginId: manifest.plugin.id,
      nodeType: "points",
      apiVersion: 1,
      parameters: { count: 100, offset: [0, 0, 0] },
    });
  });

  it("synchronizes enabled definitions and preserves isolated failures", () => {
    expect(synchronizeSceneGeneratorDefinitions(status([manifest]))).toEqual([]);
    expect(getSceneGeneratorDefinitions()).toHaveLength(1);
    const missingSource = status([manifest]);
    missingSource.report.shader_sources = { [manifest.plugin.id]: {} };
    expect(synchronizeSceneGeneratorDefinitions(missingSource)).toHaveLength(1);
    expect(getSceneGeneratorDefinitions()).toEqual([]);
  });

  it("keeps synchronization idempotent while invalidating executable changes", () => {
    synchronizeSceneGeneratorDefinitions(status([manifest]));
    const initialRevision = getSceneGeneratorRegistryRevision();
    const initialKey = getSceneGeneratorDefinitions()[0].runtimeKey;

    synchronizeSceneGeneratorDefinitions(status([structuredClone(manifest)]));
    expect(getSceneGeneratorRegistryRevision()).toBe(initialRevision);
    expect(getSceneGeneratorDefinitions()[0].runtimeKey).toBe(initialKey);

    const changed = status([manifest]);
    changed.report.shader_sources = {
      [manifest.plugin.id]: { ...sources, "compute.wgsl": "updated compute" },
    };
    synchronizeSceneGeneratorDefinitions(changed);
    expect(getSceneGeneratorRegistryRevision()).toBe(initialRevision + 1);
    expect(getSceneGeneratorDefinitions()[0].runtimeKey).not.toBe(initialKey);
  });

  it("suppresses third-party generators in safe mode", () => {
    synchronizeSceneGeneratorDefinitions({ ...status([manifest]), safeMode: true });
    expect(getSceneGeneratorDefinitions()).toEqual([]);
  });

  it("keeps the bundled plugin namespace host-owned", () => {
    const reserved = structuredClone(manifest);
    reserved.plugin.id = "org.aster.builtin.replacement";
    expect(synchronizeSceneGeneratorDefinitions(status([reserved]))[0]?.message).toContain(
      "host-reserved namespace",
    );
    expect(getSceneGeneratorDefinitions()).toEqual([]);
  });

  it("rejects undeclared executable sources at the renderer boundary", () => {
    expect(() =>
      sceneGeneratorDefinitionFromManifest(manifest, {
        ...sources,
        "undeclared.wgsl": "unexpected",
      }),
    ).toThrow("undeclared runtime shader");
  });

  it("enforces typed parameter roles and selector choices at the host boundary", () => {
    const invalidCapacity = structuredClone(manifest);
    if (!invalidCapacity.scene_generator) throw new Error("Expected generator graph fixture");
    invalidCapacity.scene_generator.capacity_parameter = "offset";
    expect(() => sceneGeneratorDefinitionFromManifest(invalidCapacity, sources)).toThrow(
      "capacity parameter must be a number",
    );

    const selected = structuredClone(manifest);
    selected.parameters.push({
      type: "choice",
      name: "style",
      label: "Style",
      default: "points",
      choices: ["points"],
    });
    if (!selected.scene_generator) throw new Error("Expected generator graph fixture");
    selected.scene_generator.render_parameter = "style";
    selected.scene_generator.render_variants[0].selector_value = "unknown";
    expect(() => sceneGeneratorDefinitionFromManifest(selected, sources)).toThrow(
      "render selectors must be declared choices",
    );

    const sharedShader = structuredClone(manifest);
    if (!sharedShader.scene_generator) throw new Error("Expected generator graph fixture");
    sharedShader.scene_generator.render_variants[0].shader = "compute.wgsl";
    expect(() => sceneGeneratorDefinitionFromManifest(sharedShader, sources)).toThrow(
      "keep compute and render shaders in separate modules",
    );
  });
});

function status(plugins: PluginManifest[]): PluginStatus {
  return {
    directory: "plugins",
    safeMode: false,
    disabled: [],
    report: {
      plugins,
      failures: [],
      shader_sources: Object.fromEntries(plugins.map((plugin) => [plugin.plugin.id, sources])),
    },
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
