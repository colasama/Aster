import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import electron from "electron";
import { createServer } from "vite";
import { captureAssignments } from "../parity/provenance.mjs";
import { auditExecutionArtifacts } from "../performance/execution-artifacts.mjs";
import { checkpointSource } from "./checkpoint-source.mjs";
import { CorpusCheckpointAudit } from "./native-project-corpus-evidence.mjs";
import { prepareProjectCorpusInputs } from "./native-project-corpus-inputs.mjs";
import { writeAtomicJson } from "./report.mjs";
import { sourceProvenance } from "./source.mjs";

/** Re-audit the entire corpus without substituting supplied TS plans for native project execution. */
export async function auditProjectCorpusCheckpoint(context) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const report = {
    id: "G2",
    kind: "native-project-corpus",
    status: "failed",
    reused: true,
    full_coverage: false,
    cases: [],
  };
  let server;
  try {
    report.source = await sourceProvenance(root);
    if (context.source) assert.equal(context.source.source_sha256, report.source.source_sha256);
    const auditor = new CorpusCheckpointAudit(root, {}),
      reader = auditor.reader;
    const resumePath = auditor.local(context.projectCorpusResume);
    report.original = { path: resumePath, sha256: (await reader.bytes(resumePath)).sha256 };
    const prior = await reader.json(resumePath, report.original.sha256);
    CorpusCheckpointAudit.assertComplete(prior);
    const sources = await checkpointSource({ ...context, source: report.source }, prior);
    report.execution_source = prior.execution_source ?? prior.source;
    sources.assert(report.execution_source.execution_sha256);
    if (sources.pin) report.source_compatibility = sources.pin;
    report.build = prior.build;
    report.execution = prior.execution;
    report.binaries = prior.binaries;
    await auditExecutionArtifacts(root, prior.execution);
    assert.equal(prior.binaries.length, 5);
    assert.equal(new Set(prior.binaries.map((file) => file.path)).size, 5);
    assert.equal(resolve(root, prior.binaries[1].path), resolve(electron));
    assert.deepEqual(
      prior.binaries.slice(2).map((file) => file.path),
      [
        "build/ffmpeg/ffmpeg.exe",
        "build/ffmpeg/ffprobe.exe",
        "node_modules/electron/dist/dxcompiler.dll",
      ],
    );
    for (const file of prior.binaries) await reader.bytes(file.path, file.sha256);
    const binary = join(root, prior.execution.run_directory, "aster-render-cli.exe");
    assert.equal(resolve(root, prior.binaries[0].path), binary);
    const manifest = await reader.json(prior.candidates.path, prior.candidates.sha256);
    assert.equal(manifest.kind, "native-project-candidate");
    const base = dirname(prior.candidates.path);
    const jobs = await reader.json(`${base}/batch.json`);
    const firstRequest = await reader.json(auditor.local(jobs[0].request));
    const rasterProvider = firstRequest.rasterProvider;
    assert.equal(resolve(rasterProvider.executable), resolve(root, prior.binaries[1].path));
    assert.deepEqual(rasterProvider.arguments, [
      join(root, prior.execution.runtime.directory, "dist-electron/electron/native-raster-host.js"),
    ]);
    assert.equal(
      rasterProvider.bundle,
      join(root, prior.execution.web.directory, "native-raster.html"),
    );
    assert.equal(
      rasterProvider.bridge,
      join(root, prior.execution.runtime.directory, "bridge/aster-desktop-bridge.exe"),
    );
    assert.equal(rasterProvider.timeoutMs, 120000);
    const inputs = await prepareProjectCorpusInputs(context, { rasterProvider });
    assert.deepEqual(prior.reference, inputs.reference);
    assert.deepEqual(
      prior.cases.map((c) => c.id),
      inputs.expected.map((c) => c.id),
    );
    assert.equal(prior.required_cases, inputs.expected.length);
    assert.equal(
      prior.required_samples,
      inputs.expected.reduce((n, c) => n + c.samples.length, 0),
    );
    assert.equal(jobs.length, inputs.jobs.length);
    server = await createServer({
      root,
      configFile: false,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null, hmr: false, ws: false },
      appType: "custom",
    });
    auditor.codecs = {
      ...(await server.ssrLoadModule("/src/renderer/frame-plan/codec.ts")),
      ...(await server.ssrLoadModule("/src/renderer/frame-plan/resources.ts")),
    };
    const declared = [];
    for (const [index, expected] of inputs.expected.entries()) {
      const job = jobs[index];
      assert.equal(job.project, inputs.jobs[index].project);
      assert.equal(job.out, join(root, base, "frames", expected.id));
      assert.equal(job.request, join(root, base, "requests", `${expected.id}.json`));
      const request = await reader.json(auditor.local(inputs.jobs[index].request));
      declared.push(...(await auditor.case(prior.cases[index], expected, job, binary, request)));
      report.cases.push(prior.cases[index]);
      context.print?.(
        `${expected.id}: authenticated ${expected.samples.length} existing native plans`,
      );
    }
    assert.deepEqual(
      manifest.frames.map((frame) => ({ ...frame, path: auditor.local(join(base, frame.path)) })),
      declared,
    );
    await inputs.reader.stable();
    report.checked_files = await reader.stable();
    assert.deepEqual(
      await captureAssignments(
        root,
        inputs.assignments.map((a) => a.case),
        context.env,
        { planReferences: true },
      ),
      inputs.assignments,
    );
    await auditExecutionArtifacts(root, prior.execution);
    report.source_after = await sourceProvenance(root);
    assert.equal(report.source.source_sha256, report.source_after.source_sha256);
    report.source_unchanged = true;
    report.reference = inputs.reference;
    report.candidates = prior.candidates;
    report.required_cases = inputs.expected.length;
    report.required_samples = prior.required_samples;
    report.full_coverage = true;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await server?.close();
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
