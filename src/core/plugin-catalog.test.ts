import { describe, expect, it } from "vitest";
import { filterRegistryEntries, type PluginRegistryEntry } from "./plugin-catalog";

const entries: PluginRegistryEntry[] = [
  {
    id: "org.aster.tint",
    name: "Soft Tint",
    summary: "GPU color treatment",
    author: "Aster",
    latestVersion: "2.0.0",
    apiVersion: 1,
    compatible: true,
    compatibleVersion: "1.1.0",
    capabilities: ["gpu_render"],
  },
  {
    id: "org.example.remote",
    name: "Remote Texture",
    summary: "Future network texture",
    author: "Example",
    latestVersion: "2.1.0",
    apiVersion: 2,
    compatible: false,
    compatibleVersion: null,
    capabilities: ["network"],
  },
];

describe("plugin registry catalog search", () => {
  it("matches all normalized terms across safe catalog metadata", () => {
    expect(filterRegistryEntries(entries, "soft GPU_RENDER")).toEqual([entries[0]]);
    expect(filterRegistryEntries(entries, "remote unavailable")).toEqual([entries[1]]);
    expect(filterRegistryEntries(entries, "ASTER 2.0")).toEqual([entries[0]]);
    expect(filterRegistryEntries(entries, "download_url")).toEqual([]);
  });

  it("returns every entry for an empty query without mutating input order", () => {
    expect(filterRegistryEntries(entries, "   ")).toBe(entries);
  });
});
