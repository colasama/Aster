import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { auditIrResources, irNegativeFixtures, loadIrRuntime } from "./ir-gate-runtime.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { sourceProvenance } from "./source.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function runIrGate(context, execute = runStep, dependencies = {}) {
  const started = Date.now();
  const report = {
    id: "G1",
    schema_version: 1,
    status: "failed",
    started_at: new Date(started).toISOString(),
    scope: "post_uniforms_slice_v1 + scene_buffers_slice_v1 + camera_parameters_slice_v1",
    renderer_plan_complete: false,
    steps: [],
    roundtrips: [],
    root_uploads: [],
    scene_uploads: [],
    camera_roundtrips: [],
    rejections: [],
  };
  const reader = new M0Evidence(context.root);
  const path = (value) => relative(context.root, value).replaceAll("\\", "/");
  const provenance = dependencies.provenance ?? sourceProvenance;
  let runtime;
  async function command(id, file, args, expectedCode = 0) {
    const step = await execute({ id, file, args }, context);
    report.steps.push(step);
    assert.equal(step.exit_code, expectedCode, `${id}: unexpected exit code`);
    assert.equal(
      step.status,
      expectedCode === 0 ? "passed" : "failed",
      `${id}: incorrect process status`,
    );
    assert(!step.error && !step.signal, `${id}: process failed outside the IR contract`);
    const log = await reader.bytes(step.log);
    return { step, log: log.bytes.toString("utf8") };
  }
  function cliReport(log, expectedKind) {
    const lines = log.split(/\r?\n/).filter((line) => line.startsWith("{"));
    assert.equal(lines.length, 1, "IR CLI must emit one structured result");
    const result = JSON.parse(lines[0]);
    assert.equal(result.schema_version, 1);
    assert.equal(result.status, expectedKind ? "passed" : "failed");
    if (expectedKind) assert.equal(result.kind, expectedKind);
    return result;
  }
  async function outputFile(output, result) {
    const file = await reader.bytes(path(output));
    assert.equal(result.sha256, file.sha256, "CLI output hash does not match published bytes");
    assert.equal(result.bytes, file.bytes.length);
    return file;
  }
  try {
    await mkdir(context.output, { recursive: true });
    report.source = await provenance(context.root);
    if (context.source)
      assert.equal(
        context.source.source_sha256,
        report.source.source_sha256,
        "Source changed before G1",
      );
    const expectedSchema = await reader.bytes("schemas/frame-plan.v1.json");
    runtime = await (dependencies.loadRuntime ?? loadIrRuntime)(context.root);
    report.limits = runtime.defaultFramePlanLimits();
    await command("ir-build", "cargo", ["build", "--release", "-p", "aster-render-cli"]);
    const libraryTests = await command("ir-library-tests", "cargo", [
      "test",
      "-p",
      "aster-render-ir",
    ]);
    assert(
      /test result: ok\. [1-9]\d* passed; 0 failed/.test(libraryTests.log),
      "The Rust IR suite did not run passing tests",
    );
    const cli = join(
      context.root,
      "target",
      "release",
      `aster-render-cli${process.platform === "win32" ? ".exe" : ""}`,
    );
    report.binary = { path: path(cli), sha256: (await reader.bytes(path(cli))).sha256 };
    const schemaPath = join(context.output, "frame-plan.raw.v1.json");
    const schemaResult = await command("ir-schema", cli, ["ir", "schema", "--out", schemaPath]);
    const rawSchema = await outputFile(schemaPath, cliReport(schemaResult.log, "ir_schema"));
    const formattedPath = join(context.output, "frame-plan.v1.json");
    const formatting = await command("ir-schema-format", "node", [
      join(context.root, "scripts/migration/ir-gate-format.mjs"),
      "--input",
      schemaPath,
      "--output",
      formattedPath,
    ]);
    const schema = await outputFile(formattedPath, cliReport(formatting.log, "ir_schema_format"));
    assert.deepEqual(
      schema.bytes,
      expectedSchema.bytes,
      "Generated FramePlan schema differs from the expected schema",
    );
    report.schema = {
      path: "schemas/frame-plan.v1.json",
      generated: path(formattedPath),
      raw: path(schemaPath),
      raw_sha256: rawSchema.sha256,
      sha256: schema.sha256,
    };
    report.resources = await auditIrResources(runtime);
    const fixtures = runtime.productionUniformFixtures();
    assert.deepEqual(
      fixtures.map((fixture) => fixture.id),
      ["zero", "fractional", "negative"],
    );
    const rootFixtures = runtime.rootPostPlanFixtures();
    assert.deepEqual(
      rootFixtures.map((fixture) => fixture.id),
      [
        "negative-zero",
        "min-subnormal",
        "max-finite",
        "f32-underflow",
        "f32-overflow",
        "fractional-rate-request-seek",
        "binary-ratio",
        "reduced-rate",
        "extreme-binary-ratio",
        "long-identity",
        "nul-identity",
        "utf16-identity",
      ],
    );
    const sceneFixtures = runtime.sceneBufferFixtures();
    assert.deepEqual(
      sceneFixtures.map((fixture) => fixture.id),
      ["scene-nested-mesh-camera", "scene-empty"],
    );
    const cameraFixtures = runtime.cameraPlanFixtures();
    assert.deepEqual(
      cameraFixtures.map((fixture) => fixture.id),
      ["camera-perspective", "camera-orthographic"],
    );
    for (const fixture of [...fixtures, ...rootFixtures, ...sceneFixtures, ...cameraFixtures]) {
      const input = join(context.output, `${fixture.id}-ts.fpln`);
      const output = join(context.output, `${fixture.id}-rust.fpln`);
      await writeFile(input, fixture.bytes, { flag: "wx" });
      const original = await reader.bytes(path(input));
      const result = await command(`ir-roundtrip-${fixture.id}`, cli, [
        "ir",
        "roundtrip",
        "--input",
        input,
        "--output",
        output,
      ]);
      const roundtrip = await outputFile(output, cliReport(result.log, "ir_roundtrip"));
      const before = runtime.decodeFramePlan(original.bytes);
      const after = runtime.decodeFramePlan(roundtrip.bytes);
      assert.deepEqual(roundtrip.bytes, original.bytes, "TS -> Rust FPLN is not byte-exact");
      assert.deepEqual(after.metadata, before.metadata);
      assert.deepEqual(after.blobs, before.blobs);
      assert.deepEqual(
        Buffer.from(runtime.encodeFramePlan(after.metadata, after.blobs)),
        original.bytes,
      );
      if (after.metadata.contract_level === "camera_parameters_slice_v1") {
        const supplied = runtime.readCameraPlan(after);
        assert.deepEqual(supplied, fixture.camera);
        assert(!("settings" in supplied) && !("transform" in supplied));
        report.camera_roundtrips.push({ id: fixture.id, evaluated_values_exact: true });
      }
      if (after.metadata.contract_level === "scene_buffers_slice_v1") {
        const prepared = runtime.prepareSceneBuffers(after);
        const writes = [];
        const draws = [];
        runtime.uploadSceneBuffers(prepared, {
          queue: {
            writeBuffer: (_target, _offset, data, offset, size) =>
              writes.push(Buffer.from(new Uint8Array(data, offset, size))),
          },
          lightingBuffer: {},
          shapeBuffer: {},
          ensureShapeBuffer: () => {},
        });
        runtime.drawSceneShadows(prepared, { draw: (...args) => draws.push(args) });
        assert.deepEqual(writes[0], Buffer.from(prepared.lighting));
        assert.equal(writes.length, prepared.vertices.length > 0 ? 2 : 1);
        if (prepared.vertices.length) assert.deepEqual(writes[1], Buffer.from(prepared.vertices));
        assert.deepEqual(
          draws,
          prepared.draws
            .filter((draw) => draw.castsShadow)
            .map((draw) => [draw.vertexCount, 1, draw.firstVertex]),
        );
        report.scene_uploads.push({
          id: fixture.id,
          supplied_payload_exact: true,
          shadow_ranges_exact: true,
          vertex_count: prepared.slice.vertex_count,
        });
      }
      if ("time" in fixture) {
        assert(Object.is(runtime.frameTimeToNumber(after.metadata.header.time), fixture.time));
        assert.equal(
          runtime.compositionIdentityToString(after.metadata.header.composition_id),
          fixture.compositionId,
        );
        const buffer = {};
        const uploads = [];
        const header = after.metadata.header;
        runtime.uploadRootPostUniformPlan(after, {
          queue: {
            writeBuffer: (target, offset, data, dataOffset, size) => {
              assert.equal(target, buffer);
              assert.equal(offset, 0);
              uploads.push(Buffer.from(new Uint8Array(data, dataOffset, size)));
            },
          },
          buffer,
          target: header.target,
          renderTarget: header.render_target,
          antiAliasing: header.aa,
        });
        assert.equal(uploads.length, 1);
        assert.deepEqual(uploads[0], Buffer.from(after.blobs[0]));
        report.root_uploads.push({
          id: fixture.id,
          time_bits_exact: true,
          composition_identity_exact: true,
          supplied_payload_exact: true,
          sha256: sha256(uploads[0]),
        });
      }
      report.roundtrips.push({
        id: fixture.id,
        input: path(input),
        output: path(output),
        sha256: original.sha256,
        blobs: before.blobs.map((blob) => ({ bytes: blob.byteLength, sha256: sha256(blob) })),
        exact: true,
      });
    }
    const rustPath = join(context.output, "independent-rust.fpln");
    const independent = await command("ir-independent-fixture", cli, [
      "ir",
      "fixture",
      "--output",
      rustPath,
    ]);
    const rust = await outputFile(rustPath, cliReport(independent.log, "ir_fixture"));
    const decoded = runtime.decodeFramePlan(rust.bytes);
    assert.equal(
      decoded.blobs.length,
      2,
      "Independent Rust fixture must exercise two distinct blobs",
    );
    assert.notEqual(
      sha256(decoded.blobs[0]),
      sha256(decoded.blobs[1]),
      "Rust fixture blobs must contain distinct values",
    );
    assert.deepEqual(
      decoded.metadata.resources,
      [report.resources.resource_hash],
      "Resource hash definitions differ between Rust and TS",
    );
    const tsPath = join(context.output, "independent-rust-ts.fpln");
    const encoded = runtime.encodeFramePlan(decoded.metadata, decoded.blobs);
    assert.deepEqual(Buffer.from(encoded), rust.bytes, "Rust -> TS FPLN is not byte-exact");
    await writeFile(tsPath, encoded, { flag: "wx" });
    await reader.bytes(path(tsPath));
    report.independent_fixture = {
      input: path(rustPath),
      output: path(tsPath),
      sha256: rust.sha256,
      exact: true,
    };
    for (const fixture of irNegativeFixtures(fixtures)) {
      const input = join(context.output, `reject-${fixture.id}.fpln`);
      const output = join(context.output, `rejected-${fixture.id}-must-not-exist.fpln`);
      assert.throws(() => runtime.decodeFramePlan(fixture.bytes), `TS accepted ${fixture.id}`);
      await writeFile(input, fixture.bytes, { flag: "wx" });
      const evidence = await reader.bytes(path(input));
      const result = await command(
        `ir-reject-${fixture.id}`,
        cli,
        ["ir", "roundtrip", "--input", input, "--output", output],
        2,
      );
      const failure = cliReport(result.log);
      assert.equal(failure.code, fixture.code, `Rust rejected ${fixture.id} for the wrong reason`);
      await assert.rejects(
        access(output),
        { code: "ENOENT" },
        "Rejected input must not publish output",
      );
      report.rejections.push({
        id: fixture.id,
        path: path(input),
        sha256: evidence.sha256,
        code: failure.code,
        status: "passed",
      });
    }
    report.custom_limits = [];
    const limitCases = [
      { id: "zero-resource-budget", limits: { max_resource_references: 0 }, accepted: true },
      {
        id: "small-container",
        limits: {
          max_container_bytes: fixtures[0].bytes.length - 1,
          max_metadata_bytes: fixtures[0].bytes.length - 1,
        },
        accepted: false,
      },
      {
        id: "invalid-limits",
        limits: {
          max_container_bytes: fixtures[0].bytes.length,
          max_metadata_bytes: fixtures[0].bytes.length + 1,
        },
        accepted: false,
      },
    ];
    for (const item of limitCases) {
      const limits = { ...report.limits, ...item.limits };
      if (item.accepted) runtime.decodeFramePlan(fixtures[0].bytes, limits);
      else assert.throws(() => runtime.decodeFramePlan(fixtures[0].bytes, limits));
      const output = join(context.output, `limits-${item.id}.fpln`);
      const flags = Object.entries(item.limits).flatMap(([key, value]) => [
        `--${key.replaceAll("_", "-")}`,
        String(value),
      ]);
      const checked = await command(
        `ir-limits-${item.id}`,
        cli,
        [
          "ir",
          "roundtrip",
          "--input",
          join(context.output, "zero-ts.fpln"),
          "--output",
          output,
          ...flags,
        ],
        item.accepted ? 0 : 2,
      );
      const result = cliReport(checked.log, item.accepted ? "ir_roundtrip" : undefined);
      if (item.accepted)
        assert.deepEqual((await outputFile(output, result)).bytes, Buffer.from(fixtures[0].bytes));
      else {
        assert.equal(result.code, "limit_exceeded");
        await assert.rejects(access(output), { code: "ENOENT" });
      }
      report.custom_limits.push({ id: item.id, limits, accepted: item.accepted, status: "passed" });
    }
    report.checked_files = await reader.stable();
    report.source_after = await provenance(context.root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged, "Source changed during G1 verification");
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  } finally {
    try {
      await runtime?.close();
    } catch (error) {
      report.status = "failed";
      report.error = [report.error, `IR runtime cleanup failed: ${error.message}`]
        .filter(Boolean)
        .join("\n");
    }
  }
  report.finished_at = new Date().toISOString();
  report.duration_ms = Date.now() - started;
  report.report_path = path(join(context.output, "report.json"));
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
