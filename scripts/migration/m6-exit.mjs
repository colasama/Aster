import assert from "node:assert/strict";
import { posix } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { auditNativePixels } from "./m3-pixels.mjs";
import { auditM4Supplements } from "./m4-supplements.mjs";
import { auditM5Supplements } from "./m5-supplements.mjs";
import { auditMediaCache } from "./m6-cache.mjs";
import { validateM6Gates } from "./m6-gates.mjs";
import { auditTimedMedia } from "./m6-media.mjs";
import { auditMixedMedia } from "./m6-mixed.mjs";

/** Completion is bound to current native execution and independently frozen pixel evidence. */
export async function auditM6Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  for (const id of ["M0", "M1", "M2", "M3", "M4", "M5"])
    assert.equal(ledger.milestones.find((m) => m.id === id)?.status, "done");
  const milestone = ledger.milestones.find((m) => m.id === "M6");
  for (const id of ["M6-T1", "M6-T2", "M6-T3"])
    assert.equal(milestone.tasks.find((t) => t.id === id)?.status, "done");
  assert(["in_progress", "done"].includes(milestone.tasks.find((t) => t.id === "M6-T4")?.status));
  const pin = ledger.milestones.find((m) => m.id === "M3");
  const manifest = await reader.json(pin.input_manifest.path, pin.input_manifest.sha256);
  assert.equal(
    (await reader.json(pin.input_capture.path, pin.input_capture.sha256)).status,
    "passed",
  );
  const corpus = await reader.json("tests/parity/corpus.json", manifest.corpus_sha256);
  const { native, selected, sequences, videos } = validateM6Gates(report, corpus);
  const output = posix.dirname(native.build.log);
  assert.deepEqual(await reader.json(`${output}/report.json`), native);
  assert.deepEqual(native.input_manifest, pin.input_manifest);
  for (const file of [native.binary, native.dxcompiler].filter(Boolean))
    await reader.bytes(file.path, file.sha256);
  for (const [field, name] of [
    ["native_sequences", "native-sequences"],
    ["native_videos", "native-videos"],
    ["native_media_frames", "native-media-frames"],
  ])
    assert.deepEqual(await reader.json(`${output}/${name}/report.json`), native[field]);
  const base = posix.dirname(pin.input_manifest.path);
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
    scope: "Native exact-frame media with recursive, temporal and retained resources",
    native_gpu_execution: true,
    media,
    pixels,
    effects,
    rasters,
    boundaries: [
      "FFmpeg snapshot decoding uploads CPU pixels; no zero-copy interop claim",
      "Distinct uncached video frames still require probe/decode processes",
      "3D, depth effects, lighting and generators remain M7",
      "Production preview/export remain TS until their integration milestones",
    ],
    checked_files: await reader.stable(),
  };
}
