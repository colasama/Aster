import { expect, it } from "vitest";
import { precompositionBundleFixtures } from "../frame-plan/precomposition-bundle-fixture";
import { omitUnavailableGenerators } from "./precomposition-generator-availability";
import type { RootSceneCommand } from "./root-scene-commands";

it("skips failed direct and isolated generators without changing attachment clears or other draws", () => {
  const plan = precompositionBundleFixtures()[0].plans[0];
  const begin = plan.commands.find((c) => c.kind === "begin_scene");
  const isolated = plan.commands.find((c) => c.kind === "begin_layer");
  if (!begin || !isolated) throw Error("Missing pass fixtures");
  const resume: RootSceneCommand = {
    ...begin,
    group: "geometry",
    color: { ...begin.color, loadOp: "load" },
    depth: { ...begin.depth, loadOp: "clear" },
  };
  const ready: RootSceneCommand = { kind: "generator", instanceId: "ready", blendMode: "screen" };
  const geometry: RootSceneCommand = { kind: "geometry", drawIndex: 0, blendMode: "normal" };
  const commands: RootSceneCommand[] = [
    begin,
    { kind: "generator", instanceId: "failed", blendMode: "normal" },
    ready,
    { kind: "end_scene" },
    isolated,
    { kind: "generator", instanceId: "failed", blendMode: "normal" },
    { kind: "finish_layer" },
    resume,
    geometry,
    { kind: "end_scene" },
  ];
  expect(omitUnavailableGenerators(commands, new Set(["failed"]))).toEqual([
    begin,
    ready,
    { kind: "end_scene" },
    resume,
    geometry,
    { kind: "end_scene" },
  ]);
  expect(omitUnavailableGenerators(commands, new Set())).toBe(commands);
  const mixed: RootSceneCommand[] = [isolated, commands[1], geometry, { kind: "finish_layer" }];
  expect(omitUnavailableGenerators(mixed, new Set(["failed"]))).toEqual([
    isolated,
    geometry,
    { kind: "finish_layer" },
  ]);
});
