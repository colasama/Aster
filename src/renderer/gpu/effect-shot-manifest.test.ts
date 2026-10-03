import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Composition, Layer } from "../../core/types";
import { createEffect, EFFECT_REGISTRY } from "../../effects/registry";
import {
  compileEffectProgram,
  FLOATS_PER_EFFECT_OPERATION,
  MAX_EFFECT_OPERATIONS,
} from "../effects/effect-program";
import { sharedShaders } from "./shared-shader-catalog";

describe("effect harness dump", () => {
  it("atomically writes compiled operation data covering every registered effect", async () => {
    const out = process.env.ASTER_EFFECT_SHOT_OUTPUT ?? "artifacts/parity/effect-shots/harness";
    const corpusBytes = await readFile("tests/parity/corpus.json");
    const corpus = JSON.parse(corpusBytes.toString("utf8")) as {
      cases: { id: string; features: string[] }[];
    };
    const registryTypes = EFFECT_REGISTRY.map((definition) => definition.type);
    expect(new Set(registryTypes).size).toBe(registryTypes.length);
    const caseIds = corpus.cases
      .filter((item) =>
        item.features.some(
          (feature) => item.id === `effect-${feature.slice(7)}` && feature.startsWith("effect:"),
        ),
      )
      .map((item) => item.id);
    expect(caseIds.sort()).toEqual(registryTypes.map((type) => `effect-${type}`).sort());
    const composition = { width: 640, height: 360 } as Composition;
    const effects = EFFECT_REGISTRY.map((definition) => {
      const effect = createEffect(definition.type);
      const layer = { effects: [effect] } as Layer;
      const program = compileEffectProgram(composition, 0.5, [layer], 1);
      expect(program.count, definition.type).toBeGreaterThan(0);
      expect(program.count, definition.type).toBeLessThanOrEqual(MAX_EFFECT_OPERATIONS);
      const ops: number[][] = [];
      for (let index = 0; index < program.count; index += 1) {
        const offset = index * FLOATS_PER_EFFECT_OPERATION;
        ops.push([...program.data.slice(offset, offset + FLOATS_PER_EFFECT_OPERATION)]);
      }
      expect(ops.flat().every(Number.isFinite), definition.type).toBe(true);
      return {
        type: definition.type,
        name: definition.name,
        case_id: `effect-${definition.type}`,
        ops,
      };
    });
    const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
    const manifest = {
      schema_version: 1,
      kind: "effect-shot-ops",
      width: composition.width,
      height: composition.height,
      time: 0.5,
      parameter_source: "registry-defaults",
      registry_types: registryTypes,
      corpus_sha256: hash(corpusBytes),
      shader_manifest_sha256: hash(await readFile("shaders/manifest.json")),
      shader_programs: ["post-process", "blur-downsample", "brightpass-downsample"].map((id) => ({
        id,
        sha256: hash(sharedShaders.source(id)),
      })),
      effects,
    };
    await mkdir(out, { recursive: true });
    const temporary = join(out, `effects.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(out, "effects.json"));
    } finally {
      await rm(temporary, { force: true });
    }
  });
});
