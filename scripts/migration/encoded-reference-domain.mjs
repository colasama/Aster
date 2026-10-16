import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { decodeRgbaPng } from "../parity/png.mjs";
import { runStep } from "./process.mjs";
import { hashFile } from "./source.mjs";

export const encodedReferencePolicy = "layered-nv12-and-uniform-reference-v1";

function conversionCommands(ffmpeg, source, nv12, decoded, width, height) {
  return [
    [
      ffmpeg,
      "-v",
      "error",
      "-nostdin",
      "-n",
      "-threads",
      "1",
      "-i",
      source,
      "-vf",
      "scale=out_color_matrix=bt709:out_range=tv,format=nv12",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      nv12,
    ],
    [
      ffmpeg,
      "-v",
      "error",
      "-nostdin",
      "-n",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "-pixel_format",
      "nv12",
      "-video_size",
      `${width}x${height}`,
      "-colorspace",
      "bt709",
      "-color_range",
      "tv",
      "-i",
      nv12,
      "-vf",
      "scale=flags=bicubic+accurate_rnd+full_chroma_int,format=rgba",
      "-frames:v",
      "1",
      "-threads",
      "1",
      decoded,
    ],
  ];
}

/** Derive only from authenticated lossless references, never from exported candidates. */
export async function prepareEncodedReferences(context, { name, width, height, samples }) {
  assert(/^[a-z][a-z0-9-]*$/.test(name));
  assert(Number.isSafeInteger(width) && width > 0 && width % 2 === 0);
  assert(Number.isSafeInteger(height) && height > 0 && height % 2 === 0);
  const output = join(context.output, `${name}-reference-domain`);
  await mkdir(output);
  const ffmpeg = resolve(context.root, "build/ffmpeg/ffmpeg.exe");
  const tool = { path: ffmpeg, sha256: await hashFile(ffmpeg) };
  const records = new Map();
  const prepare = async (source) => {
    source = resolve(source);
    if (records.has(source)) return records.get(source).decoded.path;
    const bytes = await readFile(source);
    const original = decodeRgbaPng(bytes);
    assert.equal(original.width, width);
    assert.equal(original.height, height);
    assert(original.pixels.every((value, index) => index % 4 !== 3 || value === 255));
    const sourceSha = createHash("sha256").update(bytes).digest("hex");
    const id = records.size;
    const nv12 = join(output, `${id}.nv12`),
      decoded = join(output, `${id}.png`);
    const commands = conversionCommands(ffmpeg, source, nv12, decoded, width, height);
    const steps = [];
    for (const [index, command] of commands.entries()) {
      const step = await runStep(
        { id: `${id}-${index}`, file: command[0], args: command.slice(1) },
        { ...context, output },
      );
      assert.equal(step.status, "passed", "Independent NV12 reference conversion failed");
      steps.push(step);
    }
    const raw = await readFile(nv12);
    assert.equal(raw.length, (width * height * 3) / 2);
    const pixels = decodeRgbaPng(await readFile(decoded));
    assert.equal(pixels.width, width);
    assert.equal(pixels.height, height);
    assert.equal(await hashFile(source), sourceSha, "Reference changed during conversion");
    records.set(source, {
      source: {
        path: source,
        sha256: sourceSha,
        rgba_sha256: createHash("sha256").update(original.pixels).digest("hex"),
      },
      nv12: { path: nv12, sha256: await hashFile(nv12) },
      decoded: {
        path: decoded,
        sha256: await hashFile(decoded),
        rgba_sha256: createHash("sha256").update(pixels.pixels).digest("hex"),
      },
      steps,
    });
    return decoded;
  };
  const converted = [];
  for (const sample of samples) {
    const structural = structuredClone(sample.context);
    // Isolated corpus cases currently use opaque black, which this conversion preserves exactly.
    if (structural.isolated) assert.deepEqual(structural.background, [0, 0, 0, 255]);
    structural.g5_uniform_reference = true;
    const path = await prepare(sample.path);
    if (structural.sequence)
      for (const neighbor of ["previous", "next"])
        if (structural.sequence[neighbor])
          structural.sequence[neighbor] = await prepare(structural.sequence[neighbor]);
    converted.push({ ...sample, path, context: structural });
  }
  assert.equal(await hashFile(ffmpeg), tool.sha256, "Reference converter changed");
  return {
    samples: converted,
    report: {
      policy: encodedReferencePolicy,
      width,
      height,
      tool,
      references: [...records.values()],
    },
  };
}

/** Revalidate the complete original/converted/tool chain when recovering a checkpoint. */
export async function auditEncodedReferenceDomain(reader, domain, rawReferences) {
  const local = (path) => relative(reader.root, resolve(path)).replaceAll("\\", "/");
  assert.equal(domain.policy, encodedReferencePolicy);
  assert.equal(resolve(domain.tool.path), resolve(reader.root, "build/ffmpeg/ffmpeg.exe"));
  await reader.bytes(local(domain.tool.path), domain.tool.sha256);
  const allowed = new Map(
    rawReferences.map((item) => [resolve(item.derived.path), item.derived.sha256]),
  );
  assert(domain.references.length > 0);
  assert.equal(domain.references.length, allowed.size, "Incomplete reference-domain coverage");
  const seen = new Set();
  for (const record of domain.references) {
    assert(!seen.has(resolve(record.source.path)), "Duplicate reference conversion");
    seen.add(resolve(record.source.path));
    assert.equal(
      allowed.get(resolve(record.source.path)),
      record.source.sha256,
      "Converted reference is not frozen-derived RGB",
    );
    for (const side of ["source", "nv12", "decoded"])
      await reader.bytes(local(record[side].path), record[side].sha256);
    for (const side of ["source", "decoded"]) {
      const pixels = decodeRgbaPng(
        (await reader.bytes(local(record[side].path), record[side].sha256)).bytes,
      );
      assert.equal(pixels.width, domain.width);
      assert.equal(pixels.height, domain.height);
      assert.equal(
        createHash("sha256").update(pixels.pixels).digest("hex"),
        record[side].rgba_sha256,
      );
      assert(pixels.pixels.every((value, index) => index % 4 !== 3 || value === 255));
    }
    const commands = conversionCommands(
      domain.tool.path,
      record.source.path,
      record.nv12.path,
      record.decoded.path,
      domain.width,
      domain.height,
    );
    assert.equal(record.steps.length, commands.length);
    for (const [index, step] of record.steps.entries()) {
      assert.equal(step.status, "passed");
      assert.equal(step.exit_code, 0);
      assert.deepEqual(step.command, commands[index]);
    }
  }
}

/** Recheck the exceptional registration proof from pixels, without trusting a summary flag. */
export function auditUniformReference(raw, reference, candidate) {
  if (raw.comparison.registration?.status !== "uniform_reference_equivalence") return;
  assert.equal(raw.context.g5_uniform_reference, true);
  assert.equal(raw.comparison.profile.name, "yuv");
  assert.equal(raw.comparison.registration.shift, null);
  assert.equal(typeof raw.comparison.registration.diagnostic, "string");
  assert(raw.comparison.registration.diagnostic.length > 0);
  assert.equal(reference.width, candidate.width);
  assert.equal(reference.height, candidate.height);
  const color = reference.pixels.subarray(0, 4);
  assert.equal(color[3], 255);
  for (let index = 0; index < reference.pixels.length; index++) {
    const channel = index % 4;
    assert.equal(reference.pixels[index], color[channel]);
    assert(Math.abs(candidate.pixels[index] - color[channel]) <= (channel === 3 ? 0 : 1));
  }
}
