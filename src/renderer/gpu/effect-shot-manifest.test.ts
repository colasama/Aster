import { mkdirSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import type { Composition, Layer } from "../../core/types";
import { createEffect, EFFECT_REGISTRY } from "../../effects/registry";
import { compileEffectProgram, FLOATS_PER_EFFECT_OPERATION } from "../effects/effect-program";
import { postProcessShader } from "./shaders";

describe("effect harness dump", () => {
  it("writes the shader and compiled program for every effect", () => {
    const out = "artifacts/effect-screenshots/harness";
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/post-process.wgsl`, postProcessShader);
    const composition = { width: 640, height: 360 } as Composition;
    const effects = EFFECT_REGISTRY.map((definition) => {
      const effect = createEffect(definition.type);
      const layer = { effects: [effect] } as Layer;
      const program = compileEffectProgram(composition, 0.5, [layer], 1);
      const ops: number[][] = [];
      for (let index = 0; index < program.count; index += 1) {
        const offset = index * FLOATS_PER_EFFECT_OPERATION;
        ops.push([...program.data.slice(offset, offset + FLOATS_PER_EFFECT_OPERATION)]);
      }
      return { type: definition.type, name: definition.name, ops };
    });
    writeFileSync(`${out}/effects.json`, JSON.stringify(effects));
  });
});
