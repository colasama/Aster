import assert from "node:assert/strict";
import { posix } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { auditNativePixels } from "./m3-pixels.mjs";
import { auditM4Supplements } from "./m4-supplements.mjs";
import { auditM5Supplements } from "./m5-supplements.mjs";
import { auditMediaCache } from "./m6-cache.mjs";
import { auditTimedMedia } from "./m6-media.mjs";
import { auditMixedMedia } from "./m6-mixed.mjs";
import { auditGeneratorAudio, auditSceneLifetimes } from "./m7-lifetimes.mjs";
import { validateNativeSceneGates } from "./m7-scope.mjs";
import { auditM7Supplements } from "./m7-supplements.mjs";

/** Scene completion is bound to current execution, frozen inputs and reviewed pixel identities. */
export async function auditM7Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  for (const id of ["M0", "M1", "M2", "M3", "M4", "M5", "M6"])
    assert.equal(ledger.milestones.find((m) => m.id === id)?.status, "done");
  const milestone = ledger.milestones.find((m) => m.id === "M7");
  for (const id of ["M7-T1", "M7-T2", "M7-T3", "M7-T4", "M7-T5"])
    assert.equal(milestone.tasks.find((t) => t.id === id)?.status, "done");
  assert(["in_progress", "done"].includes(milestone.tasks.find((t) => t.id === "M7-T6")?.status));
  return {
    ...(await auditNativeSceneExecution(reader, report, ledger, "M7")),
    checked_files: await reader.stable(),
  };
}

/** Reuse complete native scene provenance without relabelling an export report as an earlier milestone. */
export async function auditNativeSceneExecution(reader, report, ledger, milestone) {
  const pin = ledger.milestones.find((m) => m.id === "M3");
  const manifest = await reader.json(pin.input_manifest.path, pin.input_manifest.sha256);
  assert.equal(
    (await reader.json(pin.input_capture.path, pin.input_capture.sha256)).status,
    "passed",
  );
  const corpus = await reader.json("tests/parity/corpus.json", manifest.corpus_sha256);
  const { native, selected, sequences, videos } = validateNativeSceneGates(
    report,
    corpus,
    milestone,
  );
  const output = posix.dirname(native.build.log);
  assert.deepEqual(await reader.json(`${output}/report.json`), native);
  assert.deepEqual(native.input_manifest, pin.input_manifest);
  for (const file of [native.binary, native.dxcompiler].filter(Boolean))
    await reader.bytes(file.path, file.sha256);
  for (const field of ["native_sequences", "native_videos", "native_media_frames"])
    assert.deepEqual(
      await reader.json(`${output}/${field.replaceAll("_", "-")}/report.json`),
      native[field],
    );
  const base = posix.dirname(pin.input_manifest.path);
  const scenes = {
    lifetime: await auditSceneLifetimes(reader, native, report),
    audio: await auditGeneratorAudio(reader, native, report, base),
    supplements: await auditM7Supplements(reader, native, report, ledger),
  };
  const media = {
    sequences: await auditTimedMedia(
      reader,
      native.native_sequences,
      sequences,
      report,
      base,
      false,
    ),
    videos: await auditTimedMedia(reader, native.native_videos, videos, report, base, true),
    cache: await auditMediaCache(reader, native.native_videos, report),
    mixed: await auditMixedMedia(reader, native.native_media_frames, report, ledger),
  };
  const pixels = await auditNativePixels(reader, native, selected, report, base, false);
  const effects = await auditM4Supplements(reader, native, report, ledger);
  const rasters = await auditM5Supplements(reader, native, report, ledger);
  return {
    status: "passed",
    scope: "Native camera, depth, material, generator, cloner, motion and auxiliary execution",
    native_gpu_execution: true,
    scenes,
    media,
    pixels,
    effects,
    rasters,
    boundaries: [
      "Supplied plans retain TS evaluation until Phase B",
      "Production preview/export routing remains in its integration milestones",
      "Pixel and lifetime evidence does not establish native export or preview performance",
    ],
  };
}
