import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeRgbaPng, encodeRgbaPng } from "../parity/png.mjs";
import { hashFile } from "./source.mjs";

/** Share the exact reference domain and visitation order between export and checkpoint recovery. */
export function exportReferencePlan(assignment, composition) {
  const { case: item, benchmark } = assignment;
  const last =
    Math.ceil(
      (composition.duration * composition.frameRate.numerator) / composition.frameRate.denominator,
    ) - 1;
  const denseSegment =
    item.frames.length > 1 &&
    item.frames.length === benchmark.endFrameExclusive - benchmark.startFrame &&
    item.frames.every((frame, index) => frame === benchmark.startFrame + index);
  // A complete addressed segment already owns both interior neighbors, even without a corpus flag.
  const sequenceFirst = item.sequence ? 0 : benchmark.startFrame;
  const sequenceLast = item.sequence ? last : benchmark.endFrameExclusive - 1;
  // Seek cases declare a non-monotonic evaluation order; an MP4 still presents samples in time order.
  return item.frames
    .toSorted((a, b) => a - b)
    .map((frame) => ({
      frame,
      sequence:
        item.sequence || denseSegment
          ? {
              frame,
              first_frame: sequenceFirst,
              last_frame: sequenceLast,
              previous: frame > sequenceFirst ? frame - 1 : null,
              next: frame < sequenceLast ? frame + 1 : null,
            }
          : null,
    }));
}

/** Preserve frozen RGB bytes; MP4's opaque alpha is the only reference adaptation. */
export async function exportReferenceSamples(inputs, assignment, composition, directory) {
  const { case: item, benchmark } = assignment;
  const references = new Map(),
    evidence = [];
  const prepare = async (frame) => {
    if (references.has(frame)) return references.get(frame);
    const original = await inputs.reference(item, frame);
    assert.deepEqual(
      original.capture.inputs,
      assignment.inputs,
      "Export inputs differ from frozen reference",
    );
    const pixels = decodeRgbaPng((await inputs.bytes(original.path)).bytes);
    assert.equal(pixels.width, item.size.width);
    assert.equal(pixels.height, item.size.height);
    assert.equal(
      createHash("sha256").update(pixels.pixels).digest("hex"),
      original.meta.rgba_sha256,
    );
    for (let i = 3; i < pixels.pixels.length; i += 4) pixels.pixels[i] = 255;
    const path = join(directory, `reference-${frame}.png`);
    await writeFile(path, encodeRgbaPng(pixels.width, pixels.height, pixels.pixels), {
      flag: "wx",
    });
    references.set(frame, path);
    evidence.push({
      frame,
      original: { path: original.path, sha256: original.png_sha256 },
      derived: { path, sha256: await hashFile(path) },
      transformation: "opaque-alpha-only-rgb-unchanged",
    });
    return path;
  };
  const samples = [];
  for (const planned of exportReferencePlan(assignment, composition)) {
    const { frame } = planned;
    const path = await prepare(frame);
    const sequence = planned.sequence
      ? {
          ...planned.sequence,
          previous:
            planned.sequence.previous === null ? null : await prepare(planned.sequence.previous),
          next: planned.sequence.next === null ? null : await prepare(planned.sequence.next),
        }
      : null;
    samples.push({
      frame: frame - benchmark.startFrame,
      path,
      context: {
        case_id: item.id,
        isolated: Boolean(item.isolated),
        background: item.isolated ? [...(item.background ?? [0, 0, 0, 0]).slice(0, 3), 255] : null,
        sequence,
      },
    });
  }
  return { samples, evidence, references: samples.map((sample) => sample.path) };
}

export { scoreExportSamples } from "./export-quality.mjs";
