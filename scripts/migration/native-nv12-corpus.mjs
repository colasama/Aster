import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { nativeReleaseBuild } from "../native-build.mjs";
import { checkpointSource } from "./checkpoint-source.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { exportCaseFiles } from "./native-export-checkpoint.mjs";
import { auditNv12Case, captureNv12Case, nv12CaseInputs } from "./native-nv12-case.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, ownerProject, sourceProvenance } from "./source.mjs";

export function nv12CorpusCoverage(required, cases) {
  assert(required.length > 0 && new Set(required).size === required.length);
  assert(new Set(cases.map((c) => c.id)).size === cases.length);
  assert(cases.every((c) => required.includes(c.id)));
  const full =
    cases.length === required.length && cases.every((c) => c.authenticated && c.checkpoint);
  return {
    full_coverage: full,
    status: cases.some((c) => c.status === "failed")
      ? "failed"
      : full && cases.every((c) => c.status === "passed")
        ? "passed"
        : "incomplete",
  };
}

/** Independently checkpoint conversion cases; RGB-render and encoded-export acceptance remain separate. */
export async function runNativeNv12Corpus(
  context,
  { ids, resume, binary } = {},
  execute = runStep,
) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  context = { ...context, env: (await ownerProject(context.env)).env };
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const pin = async (path) => ({ path: local(path), sha256: await hashFile(path) });
  const report = {
    status: "failed",
    full_coverage: false,
    native_export_acceptance: false,
    scope:
      "GPU NV12 conversion of authenticated supplied frames; RGB rendering parity is independently required",
    cases: [],
  };
  try {
    report.source = await sourceProvenance(root);
    if (context.source) assert.equal(context.source.source_sha256, report.source.source_sha256);
    const reader = new M0Evidence(root);
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    report.input_manifest = ledger.milestones.find((m) => m.id === "M3").input_manifest;
    const manifest = await reader.json(report.input_manifest.path, report.input_manifest.sha256);
    const base = dirname(report.input_manifest.path).replaceAll("\\", "/");
    const corpus = await reader.json("tests/parity/corpus.json", manifest.corpus_sha256);
    report.corpus_sha256 = manifest.corpus_sha256;
    report.required = corpus.cases.map((c) => c.id);
    ids ??= report.required;
    assert(
      ids.length > 0 &&
        new Set(ids).size === ids.length &&
        ids.every((id) => report.required.includes(id)),
    );
    report.selected = ids;
    const prior = resume ? await reader.json(local(resolve(root, resume))) : null;
    const checkpointSources = await checkpointSource({ ...context, source: report.source }, prior);
    if (checkpointSources.pin) report.source_compatibility = checkpointSources.pin;
    if (!binary) {
      report.build = await execute(nativeReleaseBuild("nv12-renderer-build"), context);
      assert.equal(report.build.status, "passed");
      binary = join(root, "target/release/aster-render-cli.exe");
    }
    report.binary = await pin(binary);
    for (const id of ids) {
      const entry = { id, status: "failed", reused: false };
      report.cases.push(entry);
      try {
        const item = corpus.cases.find((c) => c.id === id),
          source = manifest.cases.find((c) => c.case_id === id);
        assert(source, "Missing supplied corpus case");
        const assignment = await nv12CaseInputs(reader, item, source, base, manifest);
        const previous = prior?.cases.find((c) => c.id === id && c.checkpoint);
        let checkpoint, measured;
        if (previous) {
          checkpoint = await reader.json(previous.checkpoint.path, previous.checkpoint.sha256);
          entry.checkpoint = previous.checkpoint;
          entry.reused = true;
        } else {
          const directory = join(output, id);
          measured = await captureNv12Case(
            { ...context, output: directory },
            assignment,
            binary,
            execute,
          );
          checkpoint = {
            schema_version: 1,
            execution_sha256: report.source.execution_sha256,
            input_manifest: report.input_manifest,
            assignment,
            report: await pin(join(directory, "report.json")),
            files: await exportCaseFiles(root, directory),
          };
        }
        assert.equal(checkpoint.schema_version, 1);
        checkpointSources.assert(checkpoint.execution_sha256);
        assert.deepEqual(checkpoint.input_manifest, report.input_manifest);
        assert.deepEqual(checkpoint.assignment, assignment);
        assert(checkpoint.files.length > 0);
        assert.equal(new Set(checkpoint.files.map((f) => f.path)).size, checkpoint.files.length);
        assert(
          checkpoint.files.some(
            (f) => f.path === checkpoint.report.path && f.sha256 === checkpoint.report.sha256,
          ),
        );
        for (const file of checkpoint.files) await reader.bytes(file.path, file.sha256);
        const raw = await reader.json(checkpoint.report.path, checkpoint.report.sha256);
        if (measured) assert.deepEqual(raw, measured);
        assert.deepEqual(raw.binary, report.binary);
        entry.review = await auditNv12Case(root, raw, assignment, ledger);
        if (!previous) {
          const path = join(output, `${id}.checkpoint.json`);
          await writeAtomicJson(path, checkpoint);
          entry.checkpoint = await pin(path);
        }
        entry.authenticated = true;
        entry.status = entry.review.status;
        entry.frame_count = raw.frames.length;
      } catch (error) {
        entry.error = error.stack ?? String(error);
      }
      await writeAtomicJson(join(output, "report.json"), report);
      context.print?.(`NV12 ${id}: ${entry.status}${entry.reused ? " (authenticated reuse)" : ""}`);
    }
    await reader.stable();
    assert.equal(await hashFile(binary), report.binary.sha256);
    report.source_after = await sourceProvenance(root);
    assert.equal(report.source.source_sha256, report.source_after.source_sha256);
    report.source_unchanged = true;
    Object.assign(report, nv12CorpusCoverage(report.required, report.cases));
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      case: { type: "string", multiple: true },
      resume: { type: "string" },
    },
  });
  assert(values.out, "--out is required");
  const report = await runNativeNv12Corpus(
    { root: process.cwd(), output: resolve(values.out), env: process.env, print: console.log },
    { ids: values.case, resume: values.resume },
  );
  console.log(
    JSON.stringify({
      status: report.status,
      full_coverage: report.full_coverage,
      error: report.error,
    }),
  );
  process.exitCode = report.status === "passed" ? 0 : 1;
}
