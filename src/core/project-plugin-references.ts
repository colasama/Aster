import type { Project } from "./types";

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Returns third-party plugin IDs referenced by portable project nodes without loading them. */
export function projectPluginReferences(project: Project): string[] {
  const pluginIds = new Set<string>();
  for (const composition of project.compositions) {
    for (const layer of composition.layers) {
      const generatorId = layer.generator?.pluginId;
      if (generatorId && !generatorId.startsWith("org.aster.builtin.")) pluginIds.add(generatorId);
      for (const effect of layer.effects) {
        if (PLUGIN_ID.test(effect.type) && !effect.type.startsWith("org.aster.builtin.")) {
          pluginIds.add(effect.type);
        }
      }
    }
  }
  return [...pluginIds].sort();
}
