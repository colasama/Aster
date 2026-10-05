import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test, { after, before } from "node:test";
import { runIrGate } from "./ir-gate.mjs";
import { formatIrSchema } from "./ir-gate-format.mjs";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";

let runtime;
before(async () => {
  runtime = await loadIrRuntime(resolve(import.meta.dirname, "../.."));
});
after(async () => {
  await runtime.close();
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t, intercept = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "aster-ir-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "artifacts/G1");
  await mkdir(output, { recursive: true });
  await mkdir(join(root, "schemas"));
  await mkdir(join(root, "target/release"), { recursive: true });
  const schema = Buffer.from(
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}\n',
  );
  await writeFile(join(root, "schemas/frame-plan.v1.json"), schema);
  await writeFile(
    join(root, "target/release", `aster-render-cli${process.platform === "win32" ? ".exe" : ""}`),
    "test-only process adapter",
  );
  const calls = [];
  const execute = async (command) => {
    calls.push(command.id);
    const log = join(output, `${command.id}.log`);
    const step = {
      id: command.id,
      status: "passed",
      exit_code: 0,
      signal: null,
      duration_ms: 1,
      log: relative(root, log).replaceAll("\\", "/"),
    };
    const argument = (key) => command.args[command.args.indexOf(key) + 1];
    let result;
    let target;
    let bytes;
    if (command.id === "ir-schema") {
      target = argument("--out");
      bytes = schema;
      result = { kind: "ir_schema" };
    } else if (command.id === "ir-schema-format") {
      target = argument("--output");
      bytes = schema;
      result = { kind: "ir_schema_format" };
    } else if (
      [
        "ir-media-resources",
        "ir-raster-resources",
        "ir-texture-resources",
        "ir-generator-shaders",
      ].includes(command.id) ||
      command.id.startsWith("ir-bundle-resources-") ||
      command.id.startsWith("ir-frame-resources-")
    ) {
      target = argument("--output");
      bytes = await readFile(argument("--input"));
      result = { kind: "ir_resources" };
    } else if (command.id.startsWith("ir-frame-reject-")) {
      step.status = "failed";
      step.exit_code = 2;
      result = { status: "failed", code: "invalid_header" };
    } else if (command.id.startsWith("ir-precomposition-reject-")) {
      step.status = "failed";
      step.exit_code = 2;
      result = { status: "failed", code: "invalid_precomposition" };
    } else if (command.id === "ir-texture-reject-bytes") {
      step.status = "failed";
      step.exit_code = 2;
      result = { status: "failed", code: "hash_mismatch" };
    } else if (command.id.startsWith("ir-raster-reject-")) {
      step.status = "failed";
      step.exit_code = 2;
      result = {
        status: "failed",
        code: {
          bytes: "hash_mismatch",
          frame: "missing_resource",
          extent: "resource_conflict",
          generation: "resource_conflict",
          "in-use": "resource_in_use",
        }[command.id.slice("ir-raster-reject-".length)],
      };
    } else if (command.id.startsWith("ir-media-reject-")) {
      step.status = "failed";
      step.exit_code = 2;
      result = {
        status: "failed",
        code: {
          hash: "hash_mismatch",
          kind: "invalid_resource",
          missing: "missing_resource",
          "in-use": "resource_in_use",
          bounds: "invalid_resource",
        }[command.id.slice("ir-media-reject-".length)],
      };
    } else if (command.id === "ir-independent-fixture") {
      const original = runtime.decodeFramePlan(runtime.productionUniformFixtures()[1].bytes);
      original.metadata.resources = [
        await runtime.resourceHash(
          { element_type: "u8", element_count: 4, byte_length: 4 },
          new Uint8Array([1, 2, 3, 4]),
        ),
      ];
      bytes = runtime.encodeFramePlan(original.metadata, original.blobs);
      target = argument("--output");
      result = { kind: "ir_fixture" };
    } else if (
      command.id.startsWith("ir-reject-") ||
      (command.id.startsWith("ir-limits-") && !command.id.endsWith("zero-resource-budget"))
    ) {
      step.status = "failed";
      step.exit_code = 2;
      const codes = {
        version: "unsupported_version",
        truncated: "container_length_mismatch",
        "unknown-field": "invalid_json",
        "unsafe-integer": "invalid_safe_integer",
        overlap: "blob_overlap",
        "invalid-resource-hash": "invalid_resource",
        "motion-extent": "invalid_header",
        "motion-samples": "invalid_header",
        "motion-nonfinite": "invalid_header",
        "motion-padding": "invalid_header",
        "post-depth-mode": "invalid_header",
        "post-depth-nonfinite": "invalid_header",
        "post-depth-range": "invalid_header",
        "post-surface-mode": "invalid_header",
        "post-surface-padding": "invalid_header",
        "auxiliary-nonfinite": "invalid_header",
        "auxiliary-range": "invalid_header",
        "auxiliary-padding": "invalid_header",
      };
      result = {
        status: "failed",
        code: codes[command.id.slice("ir-reject-".length)] ?? "limit_exceeded",
        error: "Expected fixture rejection",
      };
    } else if (
      command.id.startsWith("ir-roundtrip-") ||
      command.id.startsWith("ir-frame-stage-") ||
      command.id.startsWith("ir-limits-")
    ) {
      const original = runtime.decodeFramePlan(await readFile(argument("--input")));
      bytes = runtime.encodeFramePlan(original.metadata, original.blobs);
      target = argument("--output");
      result = { kind: "ir_roundtrip" };
    }
    if (bytes) {
      await writeFile(target, bytes, { flag: "wx" });
      result = { ...result, sha256: hash(bytes), bytes: bytes.length, path: target };
    }
    const text = result
      ? JSON.stringify({ schema_version: 1, status: "passed", ...result })
      : command.id === "ir-library-tests"
        ? "test result: ok. 12 passed; 0 failed; 0 ignored"
        : "test-only command succeeded";
    await writeFile(log, `${text}\n`);
    await intercept({ command, root, output, target, step, log });
    return step;
  };
  return {
    root,
    output,
    calls,
    run: (provenance = async () => ({ source_sha256: "a".repeat(64) })) =>
      runIrGate({ root, output, env: process.env }, execute, {
        provenance,
        loadRuntime: async () => ({ ...runtime, close: async () => {} }),
      }),
  };
}

test("G1 orchestrates all real TS codec checks and keeps renderer completion explicitly false", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, "passed", result.error);
  assert.equal(result.renderer_plan_complete, false);
  assert.equal(result.roundtrips.length, 128);
  assert.deepEqual(
    result.frame_bundles.map((bundle) => bundle.temporal_passes),
    [0, 0, 2],
  );
  assert.equal(result.auxiliary.length, 10);
  assert(
    result.auxiliary.every(
      (a) =>
        a.exact_payloads &&
        a.exact_draws &&
        a.supplied_execution &&
        a.availability_preserved &&
        a.preflight_rejection,
    ),
  );
  assert.equal(result.post_effects.length, 8);
  assert(
    result.post_effects.every(
      (p) =>
        p.exact_uniforms &&
        p.exact_routes &&
        p.supplied_execution &&
        p.settings_independent &&
        p.availability_preserved,
    ),
  );
  assert.equal(result.motion_reconstruction.length, 6);
  assert(
    result.motion_reconstruction.every(
      (r) => r.exact_uniforms && r.exact_shutter && r.supplied_execution,
    ),
  );
  assert.equal(result.final_outputs.length, 21);
  assert(result.final_outputs.every((r) => r.exact_route && r.supplied_execution));
  assert.equal(result.precomposition_bundles.length, 2);
  assert(
    result.precomposition_bundles.every(
      (b) =>
        b.exact_payloads &&
        b.exact_dependencies &&
        b.missing_rejected &&
        b.corrupt_rejected &&
        b.nested_roundtrips > 0,
    ),
  );
  assert.equal(result.precompositions.length, 2);
  assert.equal(result.precompositions[0].rejections.length, 6);
  assert(
    result.precompositions.every(
      (p) => p.exact_targets && p.exact_routes && p.exact_aliases && p.supplied_execution,
    ),
  );
  assert.equal(result.generators.length, 3);
  assert(
    result.generators.every(
      (g) =>
        g.exact_descriptors &&
        g.exact_payloads &&
        g.shader_resources_exact &&
        g.supplied_execution &&
        g.missing_rejected &&
        g.count_mismatch_rejected,
    ),
  );
  assert.equal(result.generator_resources.resources, 2);
  assert.equal(result.root_scenes.length, 3);
  assert(
    result.root_scenes.every(
      (r) => r.exact_commands && r.exact_draws && r.supplied_execution && r.invalid_order_rejected,
    ),
  );
  assert.equal(result.temporal_passes.length, 4);
  assert.equal(result.material_bindings.length, 5);
  assert(
    result.material_bindings.every(
      (b) => b.exact_scalars && b.exact_uniforms && b.supplied_hashes && b.missing_rejected,
    ),
  );
  assert.equal(result.camera_roundtrips.length, 2);
  assert.equal(result.temporal_samples.length, 5);
  assert.equal(result.scene_uploads.length, 16);
  assert.equal(result.media_draws.length, 11);
  assert.equal(result.root_uploads.length, 12);
  assert.equal(result.rejections.length, 18);
  assert.equal(result.custom_limits.length, 3);
  assert.equal(result.resources.status, "passed");
  assert.equal(result.media_resources.roundtrips, 17);
  assert.equal(result.media_resources.exact_raster_bounds, true);
  assert.equal(result.raster_pixels.resources, 3);
  assert.equal(result.texture_pixels.resources, 5);
  assert.equal(result.texture_pixels.supplied_upload, true);
  assert.equal(result.raster_pixels.exact_pixels, true);
  assert.deepEqual(
    result.raster_scenes.map((scene) => scene.origin),
    ["text", "svg", "psd"],
  );
  assert(
    result.raster_scenes.every(
      (scene) => scene.decoded_geometry_exact && scene.decoded_pixels_exact && scene.clone_replay,
    ),
  );
  assert.equal(result.media_resources.dependency_eviction, true);
  assert(f.calls.includes("ir-build") && f.calls.includes("ir-library-tests"));
  assert(result.checked_files > 20);
});

test("G1 rejects a missing, stale, or concurrently changed expected schema", async (t) => {
  for (const mode of ["missing", "stale", "changed"]) {
    const f = await fixture(t, async ({ command, root }) => {
      if (mode === "changed" && command.id === "ir-independent-fixture")
        await writeFile(join(root, "schemas/frame-plan.v1.json"), "changed after comparison");
    });
    if (mode === "missing") await rm(join(f.root, "schemas/frame-plan.v1.json"));
    if (mode === "stale") await writeFile(join(f.root, "schemas/frame-plan.v1.json"), "stale");
    const result = await f.run();
    assert.equal(result.status, "failed", mode);
    assert.match(
      result.error,
      mode === "missing" ? /ENOENT/ : mode === "stale" ? /schema differs/ : /Evidence changed/,
    );
    if (mode === "missing") assert.equal(f.calls.length, 0);
  }
});

test("G1 rejects source drift even when every codec result is exact", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const result = await f.run(async () => ({
    source_sha256: (++reads === 1 ? "a" : "b").repeat(64),
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.source_unchanged, false);
  assert.equal(result.roundtrips.length, 128);
  assert.match(result.error, /Source changed during G1/);
});

test("G1 rejects corrupt, missing, or changed round-trip evidence", async (t) => {
  for (const mode of ["corrupt", "missing", "late"]) {
    const f = await fixture(t, async ({ command, root, target }) => {
      if (command.id === "ir-roundtrip-zero") {
        if (mode === "corrupt") await writeFile(target, "damaged output");
        if (mode === "missing") await rm(target);
      }
      if (mode === "late" && command.id === "ir-independent-fixture")
        await writeFile(join(root, "artifacts/G1/zero-rust.fpln"), "changed after comparison");
    });
    const result = await f.run();
    assert.equal(result.status, "failed", mode);
    assert.match(result.error, /hash does not match|ENOENT|Evidence changed/);
  }
});

test("G1 fails closed on command errors and cannot mistake arbitrary nonzero exits for validated rejection", async (t) => {
  for (const mode of ["build", "wrong-code", "published-rejection"]) {
    const f = await fixture(t, async ({ command, target, step, log }) => {
      if (mode === "build" && command.id === "ir-build") {
        step.status = "failed";
        step.exit_code = 1;
      }
      if (command.id === "ir-reject-version") {
        if (mode === "wrong-code")
          await writeFile(
            log,
            JSON.stringify({
              schema_version: 1,
              status: "failed",
              code: "io_error",
              error: "missing executable",
            }),
          );
        if (mode === "published-rejection") {
          const output = command.args[command.args.indexOf("--output") + 1];
          await writeFile(output, "partial output");
        }
      }
      assert(target === undefined || typeof target === "string");
    });
    const result = await f.run();
    assert.equal(result.status, "failed", mode);
    assert.match(result.error, /unexpected exit|wrong reason|must not publish/);
  }
});

test("schema formatting uses the repository Biome stdin policy without modifying expected files", async (t) => {
  const root = resolve(import.meta.dirname, "../..");
  const dir = await mkdtemp(join(tmpdir(), "aster-ir-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "raw.json");
  const output = join(dir, "formatted.json");
  await writeFile(input, '{"type":"object","required":["kind","header","blobs"]}');
  const result = await formatIrSchema(input, output, root);
  const bytes = await readFile(output);
  assert.equal(result.sha256, hash(bytes));
  assert.equal(result.kind, "ir_schema_format");
  assert.deepEqual(JSON.parse(bytes), { type: "object", required: ["kind", "header", "blobs"] });
  assert.equal((await readFile(input, "utf8"))[0], "{");
  assert(result.formatter.includes("schemas/frame-plan.v1.json"));
  assert.equal(dirname(output), dir);
});
