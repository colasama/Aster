import { projectFontRevision } from "../../core/media/project-font-runtime";
import type { AntiAliasingMode } from "../../core/rendering/anti-aliasing";
import { getSceneGeneratorRegistryRevision } from "../../core/scene/scene-generator-registry";
import type { Composition, Project } from "../../core/types";
import { getPluginEffectDefinitions } from "../../effects/plugin-registry";

const generations = new WeakMap<object, number>();
let nextGeneration = 1;

/** Stable small id for an immutable document object; a new object is a new generation. */
function generation(value: object): number {
  let id = generations.get(value);
  if (id === undefined) {
    id = nextGeneration++;
    generations.set(value, id);
  }
  return id;
}

/**
 * Names every input of a finished beauty frame except its index. Document edits replace the
 * project object, and plugin or font activation changes what the same document renders, so each
 * of them starts a new scope rather than reusing frames rendered before.
 */
export function previewFrameScope(options: {
  project: Project;
  composition: Composition;
  width: number;
  height: number;
  antiAliasing: AntiAliasingMode;
}): string {
  return [
    options.composition.id,
    generation(options.project),
    generation(options.composition),
    `${options.width}x${options.height}`,
    options.antiAliasing,
    getSceneGeneratorRegistryRevision(),
    generation(getPluginEffectDefinitions()),
    projectFontRevision(),
  ].join("|");
}
