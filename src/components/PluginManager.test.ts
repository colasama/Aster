import { describe, expect, it } from "vitest";
import type { PluginManifest } from "../core/plugins";
import { filterPluginManifests } from "./PluginManager";

const plugins: PluginManifest[] = [
  {
    plugin: {
      id: "org.aster.tint",
      name: "Soft Tint",
      version: "1.2.0",
      api_version: 1,
      shader: "effect.wgsl",
    },
    capabilities: ["gpu_render"],
    parameters: [],
  },
  {
    plugin: {
      id: "org.example.noise",
      name: "Film Noise",
      version: "0.4.1",
      api_version: 1,
      shader: "noise.wgsl",
    },
    capabilities: ["gpu_compute"],
    parameters: [],
  },
];

describe("plugin search", () => {
  it("matches every case-insensitive term across metadata and capabilities", () => {
    expect(filterPluginManifests(plugins, "soft GPU_RENDER")).toEqual([plugins[0]]);
    expect(filterPluginManifests(plugins, "example 0.4")).toEqual([plugins[1]]);
    expect(filterPluginManifests(plugins, "network")).toEqual([]);
  });
});
