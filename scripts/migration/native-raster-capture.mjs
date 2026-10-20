import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import electron from "electron";
import { build, createServer, preview } from "vite";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Fresh native requests drive the retained raster boundary; reference plans are audit inputs only. */
export async function captureNativeRasters(context, options = {}) {
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const source = await sourceProvenance(context.root);
  const ledger = JSON.parse(
    await readFile(join(context.root, "docs/migration/rust-renderer-progress.json")),
  );
  const task = ledger.milestones.find((m) => m.id === "M9").tasks.find((t) => t.id === "M9-T16");
  const capture = await reader.json(task.full_capture.path, task.full_capture.sha256);
  const manifest = await reader.json(
    task.plan_reference_manifest.path,
    task.plan_reference_manifest.sha256,
  );
  assert.equal(capture.status, "passed");
  assert.equal(capture.source_unchanged, true);
  assert.deepEqual(manifest.source, capture.source);
  assert.equal(manifest.scope, "full");
  assert.equal(manifest.source_verified, true);
  for (const file of capture.source.files) await reader.bytes(file.path, file.sha256);
  const runtime = await createServer({
    root: context.root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  let server;
  const report = {
    status: "failed",
    scope: options.orderedResources
      ? "native-ordered-retained-raster-resources"
      : "native-root-retained-raster-resources",
    source,
    observations: [],
  };
  try {
    const { decodeFramePlan } = await runtime.ssrLoadModule("/src/renderer/frame-plan/codec.ts");
    const { contentResourceHashSync } = await runtime.ssrLoadModule(
      "/src/renderer/frame-plan/resources.ts",
    );
    const base = dirname(join(context.root, task.plan_reference_manifest.path));
    const selected = options.cases ?? [
      "layer-text",
      "media-svg",
      "media-psd",
      "media-psd-layer",
      "scene-text-animators",
      "scene-motion-blur",
    ];
    const assignments = [];
    const references = new Map();
    for (const id of selected) {
      const entry = manifest.cases.find((c) => c.id === id);
      assert(entry, id);
      const record = await reader.json(local(join(base, id, "capture.json")), entry.capture_sha256);
      const item = record.inputs.case;
      const projectPath =
        item.project === "env:ASTER_PERF_PROJECT"
          ? context.env.ASTER_PERF_PROJECT
          : join(context.root, item.project);
      assert(projectPath);
      const projectFile = (await stat(projectPath)).isDirectory()
        ? join(projectPath, "project.json")
        : projectPath;
      const raw = await readFile(projectFile);
      assert.equal(sha256(raw), record.inputs.project_sha256);
      const project = JSON.parse(raw),
        composition = project.compositions.find((c) => c.id === item.composition);
      assert(
        composition && item.aa === "off",
        "Raster acquisition currently requires declared AA-off corpus cases",
      );
      const samples = [];
      const records = options.maxSamples
        ? record.samples.slice(0, options.maxSamples)
        : record.samples;
      for (const sample of records) {
        const index = sample.sample.index;
        const directory = join(base, id, String(index));
        const meta = await reader.json(local(join(directory, "meta.json")), sample.meta_sha256);
        assert.equal(meta.time, sample.sample.time);
        assert.equal(meta.frame_plan.ir_cli_sha256, capture.source.ir_cli_sha256);
        const planBytes = await reader.bytes(
          local(join(directory, "replay.fpln")),
          meta.frame_plan.files["replay.fpln"],
        );
        const plan = decodeFramePlan(planBytes.bytes);
        assert.equal(plan.metadata.header.target.width, item.size.width);
        assert.equal(plan.metadata.header.target.height, item.size.height);
        assert.equal(plan.metadata.header.render_target.width, item.size.width);
        assert.equal(plan.metadata.header.render_target.height, item.size.height);
        const resources = await reader.json(
          local(join(directory, "resources.json")),
          meta.frame_plan.files["resources.json"],
        );
        references.set(`${id}/${index}`, {
          plan,
          resources,
          directory: join(base, id, "frame-resources"),
        });
        samples.push({ index, time: sample.sample.time, header: plan.metadata.header });
      }
      assignments.push({
        case: item,
        projectPath,
        project_sha256: record.inputs.project_sha256,
        resolutionScale: Math.max(
          item.size.width / composition.width,
          item.size.height / composition.height,
        ),
        samples,
      });
    }
    const cli = options.cli ?? join(context.root, "target/debug/aster-render-cli.exe");
    report.cli = { path: local(cli), sha256: await hashFile(cli) };
    report.bridge = {
      path: "target/release/aster-desktop-bridge.exe",
      sha256: await hashFile(join(context.root, "target/release/aster-desktop-bridge.exe")),
    };
    const web = join(context.output, "web");
    await build({
      root: context.root,
      configFile: false,
      logLevel: "warn",
      base: "/",
      define: { __APP_VERSION__: JSON.stringify("native-raster-check") },
      build: {
        outDir: web,
        emptyOutDir: true,
        rolldownOptions: {
          input: join(context.root, "tests/parity/native-project-resources/harness.html"),
        },
      },
    });
    server = await preview({
      root: context.root,
      configFile: false,
      build: { outDir: web },
      preview: { host: "127.0.0.1", port: 0 },
    });
    const config = {
      root: context.root,
      output: context.output,
      assignments,
      cli,
      orderedResources: options.orderedResources === true,
      url: new URL(
        "tests/parity/native-project-resources/harness.html",
        server.resolvedUrls.local[0],
      ).href,
    };
    const configPath = join(context.output, "config.json");
    await writeAtomicJson(configPath, config);
    const env = { ...context.env, ASTER_NATIVE_RASTER_CONFIG: configPath };
    delete env.ELECTRON_RUN_AS_NODE;
    report.step = await runStep(
      {
        id: "native-raster-acquisition",
        file: electron,
        args: [join(context.root, "scripts/migration/native-raster-host.mjs")],
        timeout_ms: 3600000,
      },
      { ...context, env },
    );
    const acquired = await reader.json(local(join(context.output, "capture.json")));
    assert.equal(report.step.status, "passed", acquired.error);
    assert.equal(acquired.status, "passed");
    assert.deepEqual(
      acquired.host.fonts,
      capture.host.cacheIdentity.fonts,
      "Reference fonts differ",
    );
    report.host = acquired.host;
    for (const key of ["vendor", "architecture", "device", "description"])
      assert.equal(
        acquired.host.adapter[key],
        capture.host.cacheIdentity.webgpuAdapter[key],
        `Reference adapter ${key} differs`,
      );
    assert.equal(
      acquired.frames.length,
      assignments.reduce((n, a) => n + a.samples.length, 0),
    );
    for (const frame of acquired.frames) {
      const reference = references.get(`${frame.case}/${frame.index}`);
      assert(reference);
      const directory = join(context.output, frame.case, String(frame.index));
      const observation = await reader.json(local(join(directory, "rasters.json")));
      const native = await reader.json(local(join(directory, "native-requests.json")));
      assert.deepEqual(
        Object.keys(observation.bindings).sort(),
        [
          ...new Set(
            (options.orderedResources
              ? native.preparation.operations
                  .filter((op) => op.kind === "raster")
                  .map((op) => op.request)
              : native.requests
            ).map((r) => r.instanceId),
          ),
        ].sort(),
      );
      if (options.orderedResources) {
        assert.match(native.preparationSha256, /^[a-f0-9]{64}$/);
        assert.equal(observation.requestSha256, native.preparationSha256);
      }
      for (const hash of Object.values(observation.bindings))
        assert(
          observation.pixels.some((p) => p.frame.hash === hash),
          "Native raster binding has no pixel payload",
        );
      const links = new Map(
        reference.plan.metadata.slices[0].media_pixels.map((p) => [p.frame, p.pixels]),
      );
      const referenceResources = new Map(reference.resources.map((r) => [r.hash, r]));
      for (const resource of observation.resources) {
        assert.equal(contentResourceHashSync(resource), resource.hash);
        assert.deepEqual(
          resource,
          referenceResources.get(resource.hash),
          `Raster descriptor differs: ${frame.case}/${frame.index}`,
        );
      }
      for (const pixels of observation.pixels) {
        const bytes = await reader.bytes(local(join(directory, pixels.file)), pixels.sha256);
        assert.equal(contentResourceHashSync(pixels.message, bytes.bytes), pixels.message.hash);
        const expected = links.get(pixels.frame.hash);
        assert(
          expected,
          `Raster is not linked to the reference frame: ${frame.case}/${frame.index}`,
        );
        const expectedMessage = referenceResources.get(expected);
        assert(expectedMessage);
        const expectedBytes = await reader.bytes(
          local(join(reference.directory, `${expected}.bin`)),
        );
        assert.equal(contentResourceHashSync(expectedMessage, expectedBytes.bytes), expected);
        const exact = bytes.bytes.equals(expectedBytes.bytes);
        report.observations.push({
          case: frame.case,
          index: frame.index,
          frame: pixels.frame.hash,
          candidate: pixels.sha256,
          reference: expectedBytes.sha256,
          exact,
        });
        assert(exact, `Raster pixels differ: ${frame.case}/${frame.index}/${pixels.frame.hash}`);
      }
    }
    for (const assignment of assignments) {
      const file = (await stat(assignment.projectPath)).isDirectory()
        ? join(assignment.projectPath, "project.json")
        : assignment.projectPath;
      assert.equal(await hashFile(file), assignment.project_sha256);
    }
    assert.equal(await hashFile(cli), report.cli.sha256);
    assert.equal(await hashFile(join(context.root, report.bridge.path)), report.bridge.sha256);
    report.checked_files = await reader.stable();
    report.source_after = await sourceProvenance(context.root);
    assert.equal(source.source_sha256, report.source_after.source_sha256);
    report.source_unchanged = true;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await runtime.close();
    await new Promise((resolve) => (server ? server.httpServer.close(resolve) : resolve()));
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
