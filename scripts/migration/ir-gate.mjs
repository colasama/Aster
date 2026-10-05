import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { auditGeneratorResources } from "./ir-gate-generator.mjs";
import { auditMediaResources } from "./ir-gate-media.mjs";
import { auditPrecompositionGraph } from "./ir-gate-precomposition.mjs";
import { auditPrecompositionBundle } from "./ir-gate-precomposition-bundle.mjs";
import { auditRasterPixels } from "./ir-gate-raster.mjs";
import { auditRasterScene } from "./ir-gate-raster-scene.mjs";
import { auditIrResources, irNegativeFixtures, loadIrRuntime } from "./ir-gate-runtime.mjs";
import { auditTexturePixels } from "./ir-gate-texture.mjs";
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
    scope:
      "post_uniforms_slice_v1 + scene_buffers_slice_v1 + camera_parameters_slice_v1 + temporal_text_samples_slice_v1 + temporal_text_passes_slice_v1 + material_bindings_slice_v1 + layer_effects_slice_v1 + effect_execution_slice_v1 + root_scene_commands_slice_v1 + scene_generator_slice_v1 + precomposition_graph_slice_v1 + precomposition_bundle_slice_v1",
    renderer_plan_complete: false,
    steps: [],
    roundtrips: [],
    root_uploads: [],
    scene_uploads: [],
    camera_roundtrips: [],
    media_draws: [],
    raster_scenes: [],
    temporal_samples: [],
    temporal_passes: [],
    material_bindings: [],
    layer_effects: [],
    effect_executions: [],
    root_scenes: [],
    generators: [],
    precompositions: [],
    precomposition_bundles: [],
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
    report.media_resources = await auditMediaResources(runtime, {
      context,
      cli,
      command,
      cliReport,
      outputFile,
    });
    report.raster_pixels = await auditRasterPixels(runtime, {
      context,
      cli,
      command,
      cliReport,
      outputFile,
    });
    const fixtures = runtime.productionUniformFixtures();
    report.texture_pixels = await auditTexturePixels(runtime, {
      context,
      cli,
      command,
      cliReport,
      outputFile,
    });
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
    const mediaFixtures = await runtime.sceneMediaFixtures();
    assert.equal(mediaFixtures.length, 11);
    const rasterFixtures = await runtime.rasterSceneFixtures();
    const temporalFixtures = runtime.temporalTextFixtures();
    assert.equal(temporalFixtures.length, 5);
    assert.deepEqual(
      rasterFixtures.map((fixture) => fixture.id),
      ["raster-scene-text", "raster-scene-svg", "raster-scene-psd"],
    );
    const rasterMessages = await reader.json(
      path(join(context.output, "raster-resources.output.json")),
    );
    const generatorFixtures = runtime.generatorFixtures();
    const generatorResources = await auditGeneratorResources(generatorFixtures, {
      context,
      cli,
      command,
      cliReport,
      outputFile,
    });
    report.generator_resources = {
      status: "passed",
      resources: generatorResources.size,
      bytes: [...generatorResources.values()].reduce((n, r) => n + r.bytes.length, 0),
    };
    for (const fixture of [
      ...fixtures,
      ...rootFixtures,
      ...sceneFixtures,
      ...cameraFixtures,
      ...mediaFixtures,
      ...rasterFixtures,
      ...temporalFixtures,
      ...runtime.temporalPassFixtures(),
      ...runtime.materialBindingFixtures(),
      ...runtime.layerEffectFixtures(),
      ...runtime.effectExecutionFixtures(),
      ...runtime.rootSceneFixtures(),
      ...generatorFixtures,
      ...runtime.precompositionGraphFixtures(),
      ...runtime.precompositionBundleFixtures(),
    ]) {
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
      if (fixture.bundle)
        report.precomposition_bundles.push(
          await auditPrecompositionBundle(runtime, fixture, after, {
            context,
            cli,
            command,
            cliReport,
            outputFile,
          }),
        );
      if (fixture.graph)
        report.precompositions.push(
          await auditPrecompositionGraph(runtime, fixture, after, {
            context,
            cli,
            command,
            cliReport,
          }),
        );
      assert.deepEqual(
        Buffer.from(runtime.encodeFramePlan(after.metadata, after.blobs)),
        original.bytes,
      );
      if (fixture.media) {
        const registry = new runtime.FrameResourceRegistry({
          budget_bytes: 10000,
          max_resources: 20,
        });
        for (const message of fixture.messages) await registry.apply(message);
        const handles = new Map();
        const supplied = runtime.resolveSceneMediaPlan(after, {
          bindingForHash: (hash) => {
            const resource = registry.resolve(hash);
            assert.equal(resource.content.kind, "media_frame");
            const handle = { hash, descriptor: resource.content.descriptor };
            handles.set(hash, handle);
            return handle;
          },
        });
        assert.deepEqual(after.metadata.slices[0].media_bindings, fixture.media);
        assert.equal(handles.size, 1);
        assert.equal(supplied[0].hash, fixture.messages[1].hash);
        assert.equal(supplied[1].hash, null);
        assert.equal(supplied[1].binding, undefined);
        assert.equal(supplied[0].binding, supplied[2].binding);
        await registry.apply({ type: "evict_resource", hash: supplied[0].hash });
        assert.throws(
          () =>
            runtime.resolveSceneMediaPlan(after, {
              bindingForHash: (hash) => registry.resolve(hash),
            }),
          { code: "missing_resource" },
        );
        report.media_draws.push({
          id: fixture.id,
          supplied_hashes_exact: true,
          pending_explicit: true,
          missing_rejected: true,
        });
      }
      if (fixture.generator) {
        const generator = runtime.readGeneratorSlice(after, generatorResources);
        assert.deepEqual(generator, fixture.generator);
        runtime.validateGeneratorResources(generator);
        const trace = runtime.recordGeneratorExecution(generator);
        assert.deepEqual(trace, runtime.recordGeneratorExecution(fixture.generator));
        const changed = structuredClone(generator);
        changed.parameters[0] ^= 1;
        assert.notDeepEqual(runtime.recordGeneratorExecution(changed), trace);
        assert.throws(() => runtime.readGeneratorSlice(after, new Map()));
        const bad = structuredClone(after);
        bad.blobs[0][24] ^= 1;
        assert.throws(() => runtime.readGeneratorSlice(bad, generatorResources));
        report.generators.push({
          id: fixture.id,
          exact_descriptors: true,
          exact_payloads: true,
          shader_resources_exact: true,
          supplied_execution: true,
          missing_rejected: true,
          count_mismatch_rejected: true,
          audio: generator.audio !== undefined,
        });
      }
      if (fixture.root) {
        const root = runtime.readRootScenePlan(after);
        assert.deepEqual(root, fixture.root);
        const trace = runtime.recordRootSceneExecution(root);
        assert.deepEqual(trace, runtime.recordRootSceneExecution(fixture.root));
        const broken = structuredClone(after);
        broken.metadata.slices[0].commands.pop();
        assert.throws(() => runtime.readRootScenePlan(broken));
        if (root.draws.length) {
          root.commands = root.commands.filter(
            (c) => !(c.kind === "geometry" && c.drawIndex === 0),
          );
          assert.notDeepEqual(runtime.recordRootSceneExecution(root), trace);
        }
        report.root_scenes.push({
          id: fixture.id,
          exact_commands: true,
          exact_draws: true,
          supplied_execution: true,
          invalid_order_rejected: true,
        });
      }
      if (fixture.execution) {
        assert.deepEqual(runtime.readEffectExecutionSlice(after), fixture.execution);
        const broken = structuredClone(after);
        broken.metadata.slices[0].composite =
          fixture.execution.composite === "none" ? "fixed" : "none";
        assert.throws(() => runtime.readEffectExecutionSlice(broken));
        report.effect_executions.push({
          id: fixture.id,
          exact_routing: true,
          exact_fusion: true,
          inconsistent_rejected: true,
        });
      }
      if (fixture.effect) {
        const supplied = runtime.readLayerEffectSlice(after);
        assert.deepEqual(supplied, fixture.effect);
        assert.deepEqual(
          Buffer.from(supplied.program.data.buffer).subarray(96),
          Buffer.from(after.blobs[0]).subarray(96, 4192),
        );
        const missing = structuredClone(after);
        missing.metadata.resources = [];
        assert.throws(() => runtime.readLayerEffectSlice(missing));
        report.layer_effects.push({
          id: fixture.id,
          exact_controls: true,
          exact_program: true,
          supplied_lut_hash: true,
          missing_rejected: true,
        });
      }
      if (fixture.material) {
        const binding = runtime.readMaterialBindingSlice(structuredClone(after));
        assert.deepEqual(binding, fixture.material);
        assert.deepEqual(
          runtime.materialBindingUniforms(binding),
          new Float32Array([
            fixture.material.normalScale,
            fixture.material.environmentIntensity,
            Number(fixture.material.normalEnabled),
            fixture.material.environmentRotation,
          ]),
        );
        const registry = new runtime.MaterialTextureRegistry();
        for (const [hash, role] of [
          [binding.normalHash, "normal"],
          [binding.environmentHash, "environment"],
        ]) {
          if (hash === null) continue;
          const texture = { hash };
          registry.register(hash, role, texture);
          assert.equal(registry.resolve(hash, role), texture);
          assert.throws(
            () => registry.resolve(hash, role === "normal" ? "environment" : "normal"),
            { code: "resource_conflict" },
          );
          registry.retire(hash, texture);
          assert.throws(() => registry.resolve(hash, role), { code: "missing_resource" });
        }
        report.material_bindings.push({
          id: fixture.id,
          exact_scalars: true,
          exact_uniforms: true,
          supplied_hashes: true,
          missing_rejected: true,
        });
      }
      if (fixture.raster) {
        const pixels = await reader.bytes(
          path(join(context.output, "raster-payloads", `${fixture.raster.message.hash}.bin`)),
        );
        report.raster_scenes.push(
          await auditRasterScene(runtime, after, fixture, rasterMessages, pixels.bytes),
        );
      }
      if (fixture.passes) {
        const passes = runtime.readTemporalPassSlice(structuredClone(after));
        assert.deepEqual(passes, fixture.passes);
        const writes = [];
        const bindings = new Map(after.metadata.resources.map((hash) => [hash, { hash }]));
        const draws = [];
        runtime.executeTemporalTextPassPlan(
          passes,
          {
            hashFor: (id) =>
              id === "output" ? passes.output : passes.samples[Number(id.split(":")[1])].hash,
            bindingForHash: (hash) => bindings.get(hash),
          },
          {
            beginRenderPass: () => ({
              setPipeline() {},
              setBindGroup(_slot, binding) {
                draws.push(binding.hash);
              },
              draw() {},
              end() {},
            }),
          },
          {
            queue: { writeBuffer: (_buffer, _offset, data) => writes.push([...data]) },
            width: passes.width,
            height: passes.height,
            output: { createView() {} },
            outputBinding: bindings.get(passes.output),
            accumulation: { createView() {} },
            weights: { size: passes.samples.length * 256 },
            resolveBinding: { hash: passes.output },
            accumulatePipeline: {},
            resolvePipeline: {},
          },
        );
        assert.deepEqual(draws, [...passes.samples.map((s) => s.hash), passes.output]);
        assert.equal(writes.length, passes.samples.length ? 1 : 0);
        passes.samples.forEach((sample, index) => {
          assert(Object.is(writes[0][index * 64], Math.fround(sample.weight)));
        });
        report.temporal_passes.push({
          id: fixture.id,
          exact_weights: true,
          ordered_hashes_exact: true,
          supplied_execution: true,
        });
      }
      if (fixture.temporal) {
        const supplied = runtime.readTemporalTextPlan(after);
        assert.deepEqual(supplied, fixture.temporal);
        const frame = runtime.readTextFrameSamplePlans([structuredClone(after)]);
        assert.deepEqual(frame.plans.get(supplied.resourceInstanceId), supplied.plan);
        assert.equal(
          frame.exposureResourceIds.has(supplied.resourceInstanceId),
          supplied.exposureOnly,
        );
        report.temporal_samples.push({
          id: fixture.id,
          exact_samples: true,
          exact_weights: true,
          exact_exposure: true,
          formats_preserved: true,
        });
      }
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
