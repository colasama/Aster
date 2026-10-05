import { requirePlan } from "../frame-plan/canonical";
import type { RootSceneCommand } from "./root-scene-commands";

/** Keep attachment load/clear operations while omitting failed draws and their isolated effects. */
export function omitUnavailableGenerators(
  commands: readonly RootSceneCommand[],
  unavailable: ReadonlySet<string>,
): readonly RootSceneCommand[] {
  if (unavailable.size === 0) return commands;
  const result: RootSceneCommand[] = [];
  let isolated: RootSceneCommand[] | undefined;
  let removed = false;
  for (const command of commands) {
    if (command.kind === "begin_layer") {
      requirePlan(!isolated, "invalid_root_scene", "Overlapping isolated generator layer");
      isolated = [command];
      removed = false;
    } else if (command.kind === "finish_layer") {
      requirePlan(isolated, "invalid_root_scene", "Unmatched isolated generator layer");
      if (!removed || isolated.length > 1) result.push(...isolated, command);
      isolated = undefined;
    } else if (command.kind === "generator" && unavailable.has(command.instanceId)) {
      if (isolated) removed = true;
    } else (isolated ?? result).push(command);
  }
  requirePlan(!isolated, "invalid_root_scene", "Unclosed isolated generator layer");
  return result;
}
