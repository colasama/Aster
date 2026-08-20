import { invoke } from "@tauri-apps/api/core";
import { HOST_PLUGIN_API_VERSION, type PluginCapability } from "./plugins";

export interface PluginRegistryEntry {
  id: string;
  name: string;
  summary: string;
  author: string;
  latestVersion: string;
  apiVersion: number;
  compatible: boolean;
  compatibleVersion: string | null;
  capabilities: PluginCapability[];
}

export interface PluginRegistryCatalog {
  source: string;
  developmentFixture: boolean;
  hostApiVersion: number;
  packages: PluginRegistryEntry[];
}

export async function readPluginRegistryCatalog(): Promise<PluginRegistryCatalog> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return invoke<PluginRegistryCatalog>("plugin_registry_catalog");
  }
  return browserDevelopmentCatalog();
}

export function filterRegistryEntries(
  entries: readonly PluginRegistryEntry[],
  query: string,
): readonly PluginRegistryEntry[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const searchable = [
      entry.name,
      entry.id,
      entry.summary,
      entry.author,
      entry.latestVersion,
      entry.compatible ? "compatible" : "incompatible unavailable",
      ...entry.capabilities,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

function browserDevelopmentCatalog(): PluginRegistryCatalog {
  // Keep this as a safe projection rather than importing the raw Rust fixture: browser builds
  // must not ship artifact locations or integrity metadata that the catalog UI never consumes.
  return {
    source: "Built-in development fixture",
    developmentFixture: true,
    hostApiVersion: HOST_PLUGIN_API_VERSION,
    packages: [
      {
        id: "org.aster.development.soft-tint",
        name: "Soft Tint",
        summary: "Minimal GPU render effect used to preview the registry catalog contract.",
        author: "Aster Development Fixtures",
        latestVersion: "2.0.0",
        apiVersion: 1,
        compatible: true,
        compatibleVersion: "1.1.0",
        capabilities: ["gpu_render"],
      },
      {
        id: "org.aster.development.temporal-grain",
        name: "Temporal Grain",
        summary: "GPU compute and render capability example for catalog presentation.",
        author: "Aster Development Fixtures",
        latestVersion: "0.3.0",
        apiVersion: 1,
        compatible: true,
        compatibleVersion: "0.3.0",
        capabilities: ["gpu_compute", "gpu_render"],
      },
      {
        id: "org.aster.development.remote-texture",
        name: "Remote Texture",
        summary: "Future API example that remains unavailable on the current host.",
        author: "Aster Development Fixtures",
        latestVersion: "2.1.0",
        apiVersion: 2,
        compatible: false,
        compatibleVersion: null,
        capabilities: ["gpu_render", "network"],
      },
    ],
  };
}
