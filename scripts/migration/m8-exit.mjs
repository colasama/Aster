import assert from "node:assert/strict";
import { join, posix } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { auditNativeSceneExecution } from "./m7-exit.mjs";
import { auditM8UntaggedMedia } from "./m8-media.mjs";
import { auditM8Performance } from "./m8-performance.mjs";
import { auditM8Quality } from "./m8-quality.mjs";
import { auditM8Sessions } from "./m8-session.mjs";
import { auditNativeRgbSupplement } from "./native-corpus-rgb.mjs";
import { auditExportLifecycle } from "./native-export-lifecycle.mjs";
import { runNativeNv12Corpus } from "./native-nv12-corpus.mjs";
import { ownerProject } from "./source.mjs";

/** Full export acceptance composes independently authenticated pixels, delivery, quality and speed. */
export async function auditM8Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  for (let index = 0; index < 8; index++)
    assert.equal(ledger.milestones.find((m) => m.id === `M${index}`)?.status, "done");
  const milestone = ledger.milestones.find((m) => m.id === "M8");
  for (let index = 1; index < 8; index++)
    assert.equal(milestone.tasks.find((t) => t.id === `M8-T${index}`)?.status, "done");
  assert(["in_progress", "done"].includes(milestone.tasks.find((t) => t.id === "M8-T8")?.status));
  const scenes = await auditNativeSceneExecution(reader, report, ledger, "M8");
  const native = report.gates.find((g) => g.id === "G3");
  const output = posix.dirname(posix.dirname(native.build.log));
  const env = (await ownerProject(process.env)).env;
  const corpus = await reader.json("tests/parity/corpus.json");
  const sessions = await auditM8Sessions(reader, native, report);
  const untagged = await auditM8UntaggedMedia(reader, native.native_untagged_video, report, ledger);
  const nv12Path = `${output}/G3/native-nv12-corpus/report.json`;
  assert.deepEqual(await reader.json(nv12Path), native.native_nv12);
  assert.equal(native.native_nv12.status, "passed");
  assert.equal(native.native_nv12.full_coverage, true);
  assert.equal(native.native_nv12.source_unchanged, true);
  assert.equal(native.native_nv12.source.source_sha256, report.source.source_sha256);
  assert.deepEqual(
    native.native_nv12.cases.map((c) => c.id),
    corpus.cases.map((c) => c.id),
  );
  assert(
    native.native_nv12.cases.every((c) => c.checkpoint && c.authenticated && c.status === "passed"),
  );
  const nv12 = await runNativeNv12Corpus(
    {
      root,
      output: join(root, output, "exit-audit/nv12"),
      env,
      source: report.source,
    },
    { binary: join(root, native.binary.path), resume: nv12Path },
    async () => {
      throw new Error("Exit audit cannot execute missing NV12 evidence");
    },
  );
  assert.equal(nv12.status, "passed", nv12.error);
  assert.equal(nv12.full_coverage, true);
  const rgb = await auditNativeRgbSupplement(reader, native, corpus, report);
  const gates = {};
  for (const id of ["G4", "G5", "G6"]) {
    gates[id] = await reader.json(`${output}/${id}/report.json`);
    assert.deepEqual(
      gates[id],
      report.gates.find((g) => g.id === id),
    );
  }
  assert.equal(
    gates.G6.packaged_renderer.sha256,
    native.binary.sha256,
    "Packaged renderer differs from the pixel-verified native executable",
  );
  await reader.bytes(gates.G6.packaged_renderer.path, native.binary.sha256);
  const appPath = `${output}/G6/report.json`;
  const lifecycle = await auditExportLifecycle(
    { root, source: report.source },
    {
      path: appPath,
      sha256: (await reader.bytes(appPath)).sha256,
    },
  );
  assert.equal(lifecycle.status, "passed", lifecycle.error);
  const performance = await auditM8Performance(reader, gates.G4, report, env);
  const quality = await auditM8Quality(
    reader,
    gates.G5,
    report,
    ledger,
    corpus,
    lifecycle,
    join(root, output, "exit-audit/quality"),
    env,
  );
  return {
    status: "passed",
    native_export_acceptance: true,
    scenes,
    untagged,
    sessions,
    nv12: { status: nv12.status, cases: nv12.cases.length },
    rgb,
    lifecycle,
    performance,
    quality,
    boundaries: [
      "Supplied plans still use TS evaluation until M9",
      "Production preview remains an M11 requirement",
    ],
    checked_files: await reader.stable(),
  };
}
