import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { captureAudioMixOracle } from "./native-audio-mix-oracle.mjs";
import { captureAudioSourceOracle } from "./native-audio-source-oracle.mjs";
import { captureBrowserAudioOracle } from "./native-browser-audio-oracle.mjs";
import { captureMaterialOracle } from "./native-material-oracle.mjs";
import { captureRadianceOracle } from "./native-radiance-oracle.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Independent TS resources and PCM semantics; does not establish native GPU execution. */
export async function auditNativeInputs(context, execute = runStep) {
  const reader = new M0Evidence(context.root),
    local = (p) => relative(context.root, p).replaceAll("\\", "/");
  const definitions = [
    {
      id: "browser-audio",
      capture: captureBrowserAudioOracle,
      crate: "aster-render-project",
      test: "audio_source_oracle",
      name: "native_project_audio_matches_ts",
      env: "ASTER_PROJECT_AUDIO_ORACLE",
      mutate: (o) => {
        o.cases = [o.cases[0]];
        o.cases[0].samples = [o.cases[0].samples[0]];
        o.cases[0].samples[0].mix.samples[0] += 0.1;
      },
    },
    {
      id: "audio-source",
      capture: captureAudioSourceOracle,
      crate: "aster-render-project",
      test: "audio_source_oracle",
      name: "native_project_audio_matches_ts",
      env: "ASTER_PROJECT_AUDIO_ORACLE",
      mutate: (o) => {
        o.cases = [o.cases[0]];
        o.cases[0].samples = [o.cases[0].samples[0]];
        o.cases[0].samples[0].mix.samples[0] += 0.1;
      },
    },
    {
      id: "radiance",
      capture: captureRadianceOracle,
      crate: "aster-media-native",
      test: "radiance_oracle",
      name: "native_radiance_resources_match_ts",
      env: "ASTER_RADIANCE_ORACLE",
      mutate: (o) => {
        o.cases = [o.cases.find((c) => c.expected)];
        o.cases[0].expected.sha256 = "0".repeat(64);
      },
    },
    {
      id: "material",
      capture: captureMaterialOracle,
      crate: "aster-render-project",
      test: "material_oracle",
      name: "native_project_materials_match_ts",
      env: "ASTER_PROJECT_MATERIAL_ORACLE",
      mutate: (o) => {
        o.cases = [o.cases.find((c) => c.samples.some((s) => s.hashes.length))];
        o.cases[0].samples = [o.cases[0].samples.find((s) => s.hashes.length)];
        o.cases[0].samples[0].bindings.environment = "0".repeat(64);
      },
    },
    {
      id: "audio-mix",
      capture: captureAudioMixOracle,
      crate: "aster-eval",
      test: "audio_mix_oracle",
      name: "native_audio_mix_matches_ts",
      env: "ASTER_AUDIO_MIX_ORACLE",
      mutate: (o) => {
        o.cases = [o.cases[0]];
        o.cases[0].mixes = [o.cases[0].mixes[0]];
        o.cases[0].mixes[0].expected.samples[0] += 0.1;
      },
    },
  ];
  const results = [];
  for (const definition of definitions) {
    const path = join(context.output, `${definition.id}-oracle.json`);
    const coverage = await definition.capture(context.root, path, context.env);
    const file = await reader.bytes(local(path));
    const original = JSON.parse(file.bytes),
      steps = [];
    for (const control of [null, "value", "stale-source"]) {
      let input = path;
      if (control) {
        const value = structuredClone(original);
        if (control === "value") definition.mutate(value);
        else {
          value.sources[0].sha256 = "0".repeat(64);
          value.cases = [];
        }
        input = join(context.output, `${definition.id}-${control}.json`);
        await writeAtomicJson(input, value);
        await reader.bytes(local(input));
      }
      const step = await execute(
        {
          id: `native-input-${definition.id}-${control ?? "parity"}`,
          file: "cargo",
          args: [
            "test",
            "-p",
            definition.crate,
            "--test",
            definition.test,
            definition.name,
            "--",
            "--ignored",
            "--exact",
          ],
        },
        { ...context, env: { ...context.env, [definition.env]: input } },
      );
      steps.push(step);
      assert(!step.error && !step.signal);
      assert.equal(step.exit_code, control ? 101 : 0);
      const log = (await reader.bytes(step.log)).bytes.toString("utf8");
      assert(
        control
          ? /test result: FAILED\. 0 passed; 1 failed; 0 ignored/.test(log)
          : /test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log),
      );
    }
    for (const proof of original.sources)
      assert.equal(sha256(await readFile(resolve(context.root, proof.path))), proof.sha256);
    results.push({
      id: definition.id,
      status: "passed",
      ...coverage,
      oracle: { path: local(path), sha256: file.sha256 },
      steps,
    });
  }
  return {
    status: "passed",
    scope: "native-material-and-audio-input-components",
    gpu_execution: false,
    results,
    checked_files: await reader.stable(),
  };
}
