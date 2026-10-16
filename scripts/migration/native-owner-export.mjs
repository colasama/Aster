import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import electron from "electron";
import { Window } from "happy-dom";
import { build, createServer } from "vite";
import { nativeExportWorkloads } from "./native-export-series.mjs";
import { prepareNativeObservationRuntime } from "./native-observation-runtime.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    frames: { type: "string" },
    segment: { type: "string", default: "owner-main" },
    profile: { type: "boolean", default: false },
    paired: { type: "boolean", default: false },
    smoke: { type: "boolean", default: false },
  },
});
assert(values.out, "--out is required");
assert(nativeExportWorkloads.includes(values.segment), "Unknown native export workload");
assert(!(values.paired && values.profile), "Paired export cannot use profiling");
assert(
  !(values.paired && values.frames),
  "Paired export requires complete ranges; use --smoke for diagnostics",
);
const root = process.cwd();
const output = resolve(values.out);
const owner = values.segment.startsWith("owner-");
const projectRoot = owner
  ? await realpath(process.env.ASTER_PERF_PROJECT || "D:/code/SD04PV")
  : root;
await mkdir(output, { recursive: true });
const privateRoot = await mkdtemp(join(tmpdir(), "aster-owner-export-"));
const report = { status: "failed", native_export_acceptance: false, steps: [] };
let server;
const previousGlobals = {
  window: globalThis.window,
  DOMParser: globalThis.DOMParser,
  XMLSerializer: globalThis.XMLSerializer,
  fetch: globalThis.fetch,
};
const dom = new Window();
try {
  report.source = await sourceProvenance(root);
  server = await createServer({
    configFile: false,
    root,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  const generated = owner
    ? undefined
    : (await server.ssrLoadModule("/scripts/performance/workloads.ts"))
        .performanceFixtures()
        .find((item) => item.case.id === values.segment);
  const projectPath = owner ? join(projectRoot, "project.json") : undefined;
  const raw = owner ? JSON.parse(await readFile(projectPath, "utf8")) : generated.project;
  report.project_sha256 = owner
    ? await hashFile(projectPath)
    : createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  const allowed = new Set();
  // Use the same local scheme as production; never persist private project data in the repository.
  for (const asset of [
    ...raw.sources,
    ...raw.compositions.flatMap((c) => c.layers.map((l) => l.asset).filter(Boolean)),
  ]) {
    const candidate = asset.relativePath
      ? resolve(projectRoot, asset.relativePath)
      : asset.externalPath;
    if (!candidate) continue;
    const path = await realpath(candidate);
    const displacement = relative(projectRoot, path);
    assert(
      !isAbsolute(displacement) && displacement !== ".." && !displacement.startsWith(`..${sep}`),
      "Asset escapes the owner project",
    );
    allowed.add(path);
    asset.runtimeUrl = `aster-asset://local/${encodeURIComponent(path)}`;
    delete asset.resolvedPath;
  }
  const { validateProjectDocument } = await server.ssrLoadModule(
    "/src/core/project/validation/document.ts",
  );
  const { createRenderQueueJob } = await server.ssrLoadModule(
    "/src/render-queue/render-job-builder.ts",
  );
  const { ownerCases } = await server.ssrLoadModule("/tests/parity/external-cases.ts");
  const project = validateProjectDocument(raw);
  assert(
    project.sources.every((s) => ["still", "video", "audio", "svg"].includes(s.kind)),
    "Owner capture needs browser hydration for advanced media",
  );
  const imports = structuredClone(raw.mediaImports);
  for (const payload of imports?.payloads ?? []) {
    if (payload.storage?.kind !== "relative") continue;
    const path = await realpath(resolve(projectRoot, payload.storage.relativePath));
    const displacement = relative(projectRoot, path);
    assert(
      !isAbsolute(displacement) && displacement !== ".." && !displacement.startsWith(`..${sep}`),
    );
    allowed.add(path);
    payload.storage.resolvedPath = path;
  }
  globalThis.window = {
    asterDesktop: { convertFileSrc: (path) => `aster-asset://local/${encodeURIComponent(path)}` },
  };
  globalThis.DOMParser = dom.DOMParser;
  globalThis.XMLSerializer = dom.XMLSerializer;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "aster-asset:");
    assert.equal(parsed.hostname, "local");
    const path = decodeURIComponent(parsed.pathname.slice(1));
    assert(allowed.has(path), "Hydration path is not authorized");
    const bytes = await readFile(path);
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  };
  const { hydratePersistedMediaImports } = await server.ssrLoadModule(
    "/src/importers/media-import-persistence-hydration.ts",
  );
  await hydratePersistedMediaImports(project, imports, { allowResolvedPaths: true });
  const svgInputs = [];
  for (const entry of (imports?.entries ?? []).filter((entry) => entry.kind === "svg")) {
    const payload = imports.payloads.find((p) => p.id === entry.payloadId);
    const bytes =
      payload.storage.kind === "relative"
        ? await readFile(payload.storage.resolvedPath)
        : Buffer.from(payload.storage.data, "base64");
    svgInputs.push({
      sourceId: entry.sourceId,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    });
  }
  const workload = owner
    ? ownerCases(project).find((c) => c.id === values.segment)
    : generated.case;
  assert(workload, "Unknown owner segment");
  const composition = project.compositions.find((c) => c.id === workload.composition);
  const start = Math.min(...workload.frames);
  const fullEnd = Math.max(...workload.frames) + 1;
  const count = values.smoke
    ? Math.min(10, fullEnd - start)
    : values.frames === undefined
      ? fullEnd - start
      : Number(values.frames);
  assert(Number.isSafeInteger(count) && count > 0 && start + count <= fullEnd);
  const rate = composition.frameRate.numerator / composition.frameRate.denominator;
  const manifest = createRenderQueueJob({
    project,
    composition,
    projectRevision: 0,
    antiAliasing: workload.aa,
    output: { kind: "mp4", bitrateMbps: 20, includeAudio: owner },
    destination: join(output, "placeholder.mp4"),
    range: "custom",
    customRange: { start: start / rate, end: (start + count) / rate },
    currentTime: 0,
  });
  assert.equal(manifest.startFrame, start);
  assert.equal(manifest.endFrameExclusive, start + count);
  await server.close();
  server = undefined;
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    build: {
      outDir: join(privateRoot, "parser"),
      emptyOutDir: false,
      lib: {
        entry: join(root, "src/importers/svg.ts"),
        name: "OwnerSvg",
        formats: ["iife"],
        fileName: () => "svg.js",
      },
    },
  });
  report.workload = {
    id: workload.id,
    start_frame: start,
    end_frame_exclusive: start + count,
    full_end_frame_exclusive: fullEnd,
    width: composition.width,
    height: composition.height,
    frame_rate: composition.frameRate,
    bitrate_mbps: 20,
    include_audio: owner,
  };
  report.paired = values.paired;
  report.smoke = values.smoke;
  const runtime = await prepareNativeObservationRuntime(
    { root, output: join(output, "runtime-build"), env: process.env },
    runStep,
    { application: true },
  );
  assert.equal(runtime.source.source_sha256, report.source.source_sha256);
  report.build = runtime.build;
  report.execution_artifacts = runtime.execution.snapshot;
  const config = join(privateRoot, "config.json");
  await writeAtomicJson(config, {
    root,
    output,
    privateRoot,
    profile: values.profile,
    paired: values.paired,
    smoke: values.smoke,
    allowed: [...allowed],
    manifest,
    svgInputs,
    source: report.source,
    appPath: runtime.appPath,
    nativeRuntime: runtime.nativeRuntime,
  });
  const result = await runStep(
    {
      id: "owner-queue",
      file: electron,
      args: ["scripts/migration/native-owner-queue-electron.mjs"],
      env: {
        ASTER_OWNER_EXPORT_CONFIG: config,
        ...(values.paired ? { NODE_ENV: "production" } : {}),
      },
      timeout_ms: values.paired ? 14_400_000 : 1800000,
    },
    { root, output, env: process.env },
  );
  report.steps.push(result);
  report.queue = JSON.parse(await readFile(join(output, "queue-report.json"), "utf8"));
  assert.equal(result.status, "passed", report.queue.error);
  assert.equal(report.queue.status, "passed", report.queue.error);
  await runtime.assertUnchanged();
  if (projectPath)
    assert.equal(
      await hashFile(projectPath),
      report.project_sha256,
      "Owner project changed during export",
    );
  assert.equal(
    (await sourceProvenance(root)).source_sha256,
    report.source.source_sha256,
    "Source changed during export",
  );
  report.status = "passed";
} catch (error) {
  report.error = error.stack ?? String(error);
} finally {
  Object.assign(globalThis, previousGlobals);
  await dom.happyDOM.close();
  await server?.close();
  // mkdtemp owns this exact directory; reject any unexpected path before recursive cleanup.
  assert.equal(resolve(privateRoot, ".."), resolve(tmpdir()));
  await rm(privateRoot, { recursive: true, force: true });
  report.private_snapshots_removed = true;
  await writeAtomicJson(join(output, "report.json"), report);
}
console.log(
  JSON.stringify({
    status: report.status,
    workload: report.workload,
    jobs: report.queue?.jobs.map(({ renderer, status, fps, elapsed_ms, progress, route }) => ({
      renderer,
      status,
      fps,
      elapsed_ms,
      progress,
      route,
    })),
    error: report.error,
  }),
);
process.exitCode = report.status === "passed" ? 0 : 1;
