import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { evidencePath, M0Evidence, stableSource, validSha } from "../migration/m0-evidence.mjs";
import { runStep } from "../migration/process.mjs";
import { writeAtomicJson } from "../migration/report.mjs";
import { hashFile, sourceProvenance } from "../migration/source.mjs";

function validateManifest(manifest, corpus) {
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.kind, "effect-shot-ops");
  assert.equal(manifest.width, 640);
  assert.equal(manifest.height, 360);
  assert.equal(manifest.time, 0.5);
  assert.equal(manifest.parameter_source, "registry-defaults");
  const cases = corpus.cases.filter((item) =>
    item.features.some(
      (feature) => feature.startsWith("effect:") && item.id === `effect-${feature.slice(7)}`,
    ),
  );
  assert(cases.length > 0, "No canonical effect cases in the corpus");
  const expected = cases.map((item) => item.id).sort();
  assert.equal(new Set(expected).size, expected.length, "Duplicate canonical effect case");
  assert.deepEqual(
    manifest.effects.map((entry) => entry.case_id).sort(),
    expected,
    "Effect coverage differs from corpus",
  );
  assert.deepEqual(
    manifest.registry_types,
    manifest.effects.map((entry) => entry.type),
  );
  for (const entry of manifest.effects) {
    assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.type), "Invalid effect identifier");
    assert.equal(entry.case_id, `effect-${entry.type}`);
    assert(typeof entry.name === "string" && entry.name.length > 0);
    assert(
      Array.isArray(entry.ops) && entry.ops.length > 0 && entry.ops.length <= 64,
      "Invalid effect operation count",
    );
    for (const operation of entry.ops)
      assert(
        Array.isArray(operation) && operation.length === 16 && operation.every(Number.isFinite),
        "Invalid effect operation data",
      );
  }
  assert.deepEqual(
    manifest.shader_programs.map((program) => program.id),
    ["post-process", "blur-downsample", "brightpass-downsample"],
  );
  for (const program of manifest.shader_programs) validSha(program.sha256);
}

/** Re-read the smoke's real inputs and decoded PNGs; this is not a pixel-parity oracle. */
export async function auditEffectShotFiles(root, report) {
  const reader = new M0Evidence(root);
  assert.equal(report.schema_version, 1);
  assert.equal(report.kind, "native-effect-shader-smoke");
  stableSource(report.source_before, report.source_after, "source_sha256");
  assert.equal(report.source_sha256, report.source_before.source_sha256);
  assert.equal(report.corpus.path, "tests/parity/corpus.json");
  assert.equal(report.shader_manifest.path, "shaders/manifest.json");
  const corpus = await reader.json(report.corpus.path, report.corpus.sha256);
  await reader.bytes(report.shader_manifest.path, report.shader_manifest.sha256);
  const manifest = await reader.json(report.manifest.path, report.manifest.sha256);
  validateManifest(manifest, corpus);
  assert.equal(manifest.corpus_sha256, report.corpus.sha256);
  assert.equal(manifest.shader_manifest_sha256, report.shader_manifest.sha256);
  assert.deepEqual(report.registry_types, manifest.registry_types);
  const directory = evidencePath(report.output_directory);
  assert.equal(report.native_report.path, `${directory}/report.json`);
  const native = await reader.json(report.native_report.path, report.native_report.sha256);
  assert.equal(native.schema_version, 1);
  assert.equal(native.status, "passed");
  for (const key of ["name", "device_type", "backend"])
    assert(
      typeof native.adapter?.[key] === "string" && native.adapter[key].length > 0,
      "Native GPU adapter evidence is missing",
    );
  for (const key of ["driver", "driver_info"]) assert.equal(typeof native.adapter[key], "string");
  for (const key of ["vendor", "device"])
    assert(
      Number.isInteger(native.adapter[key]) &&
        native.adapter[key] >= 0 &&
        native.adapter[key] <= 0xffff_ffff,
      "Invalid native adapter identifier",
    );
  assert.equal(
    native.effects_manifest_sha256,
    report.manifest.sha256,
    "Native effect input is stale",
  );
  assert.deepEqual(
    native.shader_sources,
    manifest.shader_programs,
    "Native and TS shared shader sources differ",
  );
  assert(Array.isArray(native.images), "Missing native image evidence");
  assert.equal(native.images.length, manifest.effects.length, "Incomplete native effect coverage");
  const expectedNames = new Set(["report.json"]);
  const outputs = [];
  for (const [index, entry] of manifest.effects.entries()) {
    const output = native.images[index];
    const file = `${String(index + 1).padStart(3, "0")}-${entry.type}.png`;
    assert.equal(output.type, entry.type, "Native effect order or identity differs");
    assert.equal(output.file, file, "Unexpected native output path");
    assert.equal(output.width, manifest.width);
    assert.equal(output.height, manifest.height);
    expectedNames.add(file);
    const path = `${directory}/${file}`;
    const image = await reader.image(path, output.png_sha256);
    assert.equal(image.width, manifest.width, "PNG width differs from input");
    assert.equal(image.height, manifest.height, "PNG height differs from input");
    outputs.push({
      type: entry.type,
      case_id: entry.case_id,
      path,
      png_sha256: image.png_sha256,
      rgba_sha256: image.rgba_sha256,
      width: image.width,
      height: image.height,
    });
  }
  const files = await readdir(join(root, directory), { withFileTypes: true });
  assert(
    files.every((entry) => entry.isFile()),
    "Native outputs must be regular files",
  );
  assert.deepEqual(
    files.map((entry) => entry.name).sort(),
    [...expectedNames].sort(),
    "Missing or extra native output files",
  );
  if (report.outputs) assert.deepEqual(report.outputs, outputs, "Recorded output checks are stale");
  assert.equal(
    report.steps?.length,
    2,
    "Both fresh TS compilation and native rendering are required",
  );
  for (const [index, id] of ["effect-shot-ops", "effect-shot-native"].entries()) {
    const step = report.steps[index];
    assert.equal(step.id, id);
    assert.equal(step.status, "passed");
    assert.equal(step.exit_code, 0);
  }
  assert.deepEqual(report.steps[0].command, [
    "pnpm",
    "exec",
    "vitest",
    "run",
    "src/renderer/gpu/effect-shot-manifest.test.ts",
  ]);
  assert.deepEqual(report.steps[1].command, [
    "cargo",
    "run",
    "--release",
    "-p",
    "aster-render",
    "--example",
    "effect_shots",
    "--",
    "--manifest",
    join(root, dirname(report.manifest.path)),
    "--out",
    join(root, dirname(report.output_directory), "pending"),
  ]);
  return {
    status: "passed",
    effects: outputs.length,
    adapter: native.adapter,
    outputs,
    checked_files: await reader.stable(),
  };
}

/** Compile fresh TS operation data, then exercise native shared shaders in a new output directory. */
export async function runEffectShotSmoke(context, execute = runStep) {
  const root = resolve(context.root);
  const parent = join(root, "artifacts", "parity", "effect-shots", "runs");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "smoke-"));
  const relativePath = (path) => relative(root, path).replaceAll("\\", "/");
  const pending = join(directory, "pending");
  const output = join(directory, "native");
  const harness = join(directory, "harness");
  const reportPath = join(directory, "report.json");
  const report = {
    schema_version: 1,
    kind: "native-effect-shader-smoke",
    status: "failed",
    started_at: new Date().toISOString(),
    scope:
      "Registry-default operation data and native shared shader execution; no native pixel parity claim",
    steps: [],
  };
  try {
    report.source_before = await sourceProvenance(root);
    report.source_sha256 = report.source_before.source_sha256;
    const runContext = { ...context, root, output: join(directory, "logs") };
    report.steps.push(
      await execute(
        {
          id: "effect-shot-ops",
          file: "pnpm",
          args: ["exec", "vitest", "run", "src/renderer/gpu/effect-shot-manifest.test.ts"],
          env: { ASTER_EFFECT_SHOT_OUTPUT: harness },
        },
        runContext,
      ),
    );
    assert.equal(report.steps[0].status, "passed", "TS operation compilation failed");
    assert.equal(report.steps[0].exit_code, 0);
    const reader = new M0Evidence(root);
    const manifestPath = `${relativePath(harness)}/effects.json`;
    const manifestFile = await reader.bytes(manifestPath);
    report.manifest = { path: manifestPath, sha256: manifestFile.sha256 };
    report.corpus = {
      path: "tests/parity/corpus.json",
      sha256: (await reader.bytes("tests/parity/corpus.json")).sha256,
    };
    report.shader_manifest = {
      path: "shaders/manifest.json",
      sha256: (await reader.bytes("shaders/manifest.json")).sha256,
    };
    const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
    validateManifest(manifest, await reader.json(report.corpus.path));
    assert.equal(manifest.corpus_sha256, report.corpus.sha256);
    assert.equal(manifest.shader_manifest_sha256, report.shader_manifest.sha256);
    assert.deepEqual(
      await readdir(harness),
      ["effects.json"],
      "The operation dump must not export shaders or reuse other inputs",
    );
    report.registry_types = manifest.registry_types;
    report.steps.push(
      await execute(
        {
          id: "effect-shot-native",
          file: "cargo",
          args: [
            "run",
            "--release",
            "-p",
            "aster-render",
            "--example",
            "effect_shots",
            "--",
            "--manifest",
            harness,
            "--out",
            pending,
          ],
        },
        runContext,
      ),
    );
    assert.equal(report.steps[1].status, "passed", "Native effect rendering failed");
    assert.equal(report.steps[1].exit_code, 0);
    report.source_after = await sourceProvenance(root);
    stableSource(report.source_before, report.source_after, "source_sha256");
    await reader.stable();
    report.output_directory = relativePath(pending);
    report.native_report = {
      path: `${report.output_directory}/report.json`,
      sha256: await hashFile(join(pending, "report.json")),
    };
    const checked = await auditEffectShotFiles(root, report);
    await rename(pending, output);
    report.output_directory = relativePath(output);
    report.native_report.path = `${report.output_directory}/report.json`;
    report.outputs = checked.outputs.map((image) => ({
      ...image,
      path: `${report.output_directory}/${image.path.split("/").at(-1)}`,
    }));
    report.checks = {
      effects: checked.effects,
      checked_files: checked.checked_files,
      fresh_inputs: true,
      shared_shader_hashes_equal: true,
      complete_png_coverage: true,
      source_unchanged: true,
    };
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
    const actual = await realpath(pending).catch(() => null);
    if (actual) {
      assert.equal(
        actual,
        join(await realpath(directory), "pending"),
        "Cleanup target escaped this smoke run",
      );
      await rm(pending, { recursive: true, force: true });
    }
  }
  report.finished_at = new Date().toISOString();
  await writeAtomicJson(reportPath, report);
  return {
    status: report.status,
    report_path: relativePath(reportPath),
    report_sha256: await hashFile(reportPath),
    source_sha256: report.source_sha256,
    effects: report.outputs?.length ?? 0,
    ...(report.error ? { error: report.error } : {}),
  };
}
