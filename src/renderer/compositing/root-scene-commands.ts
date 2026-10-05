import type { BlendMode } from "../../core/types";
import type { EffectExecution } from "../frame-plan/effect-execution-plan";
import type { PlannedSceneStack } from "./render-stack";

export type RootSceneCommand =
  | {
      kind: "begin_scene";
      group: "composition" | "generator" | "geometry";
      color: {
        loadOp: GPULoadOp;
        storeOp: GPUStoreOp;
        clearValue: [number, number, number, number];
      };
      depth: { loadOp: GPULoadOp; storeOp: GPUStoreOp; clearValue: number };
    }
  | { kind: "end_scene" }
  | { kind: "begin_layer"; effect: EffectExecution }
  | { kind: "finish_layer" }
  | { kind: "adjustment"; effect: EffectExecution }
  | { kind: "geometry"; drawIndex: number; blendMode: BlendMode }
  | { kind: "generator"; instanceId: string; blendMode: BlendMode };

/** Resolve ordering and pass boundaries once; execution must not rediscover routing. */
export function planRootSceneCommands(
  stack: Pick<PlannedSceneStack, "items">,
  effects: ReadonlyMap<string, EffectExecution>,
  generators: ReadonlySet<string>,
  background: readonly [number, number, number, number],
): RootSceneCommand[] {
  const commands: RootSceneCommand[] = [
    {
      kind: "begin_scene",
      group: "composition",
      color: { loadOp: "clear", storeOp: "store", clearValue: [...background] },
      depth: { loadOp: "clear", storeOp: "store", clearValue: 1 },
    },
  ];
  let sceneOpen = true;
  let clearDepth = false;
  const drawnGenerators = new Set<string>();
  const endScene = () => {
    if (sceneOpen) commands.push({ kind: "end_scene" });
    sceneOpen = false;
  };
  for (const item of stack.items) {
    if (item.clearDepth) {
      endScene();
      clearDepth = true;
    }
    if (
      item.kind === "generator" &&
      (!generators.has(item.instanceId) || drawnGenerators.has(item.instanceId))
    )
      continue;
    const effect = effects.get(item.instanceId);
    if (!effect) throw new Error(`Missing root effect execution: ${item.instanceId}`);
    if (item.kind === "adjustment") {
      if (effect.route === "skip") continue;
      endScene();
      commands.push({ kind: "adjustment", effect: structuredClone(effect) });
      continue;
    }
    const isolated = effect.route === "layer";
    if (isolated) {
      endScene();
      commands.push({ kind: "begin_layer", effect: structuredClone(effect) });
    } else if (!sceneOpen) {
      commands.push({
        kind: "begin_scene",
        group: item.kind,
        color: { loadOp: "load", storeOp: "store", clearValue: [0, 0, 0, 0] },
        depth: { loadOp: clearDepth ? "clear" : "load", storeOp: "store", clearValue: 1 },
      });
      sceneOpen = true;
      clearDepth = false;
    }
    const blendMode = isolated ? "normal" : effect.blendMode;
    if (item.kind === "generator") {
      commands.push({ kind: "generator", instanceId: item.instanceId, blendMode });
      drawnGenerators.add(item.instanceId);
    } else commands.push({ kind: "geometry", drawIndex: item.drawIndex, blendMode });
    if (isolated) commands.push({ kind: "finish_layer" });
  }
  endScene();
  return commands;
}
