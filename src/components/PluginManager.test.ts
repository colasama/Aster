import { describe, expect, it } from "vitest";
import type { PluginManifest, PluginStatus } from "../core/plugins";
import { describeHotReload, filterPluginManifests } from "./PluginManager";

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

describe("plugin hot reload status", () => {
  it("surfaces debounce and safe-mode suspension", () => {
    const status: PluginStatus = {
      directory: "plugins",
      safeMode: false,
      disabled: [],
      report: { plugins: [], failures: [] },
      native: true,
      hotReload: {
        enabled: true,
        suspendedBySafeMode: false,
        pending: true,
        revision: 1,
        successfulReloads: 1,
        rejectedReloads: 0,
        diagnostics: [],
      },
    };
    expect(describeHotReload(status)).toContain("waiting for files to settle");
    expect(describeHotReload({ ...status, safeMode: true })).toContain("Suspended");
  });
});
