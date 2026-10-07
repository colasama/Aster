import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStillRejections } from "./native-still-rejections.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

export const nativeSequenceCases = ["media-image-sequence", "media-image-sequence-identity"];

/** Original plans decode authorized members; reverse requests must reproduce forward pixels. */
export async function runNativeSequenceGate(
  context,
  { base, binary, compiler, validateReceipt },
  execute = runStep,
) {
  const report = { status: "failed", native_image_decode: true, frames: [] };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const catalog = await reader.json("tests/parity/assets/media-assets.json");
    const corpus = await reader.json("tests/parity/corpus.json");
    const ffmpeg = join(context.root, "build/ffmpeg/ffmpeg.exe");
    report.ffmpeg = { path: local(ffmpeg), sha256: await hashFile(ffmpeg) };
    const assets = [];
    for (let member = 0; member < 4; member++) {
      const name = `sequence-${String(member).padStart(4, "0")}.png`;
      const asset = catalog.assets[name];
      const path = join(context.output, name);
      await writeFile(path, Buffer.from(asset.data, "base64"), { flag: "wx" });
      await reader.bytes(local(path), asset.sha256);
      assets.push({ ...asset, path });
    }
    const inputs = [],
      grants = new Map(),
      jobs = [];
    for (const id of nativeSequenceCases) {
      const item = corpus.cases.find((c) => c.id === id);
      assert(item);
      for (const frame of item.frames) {
        const input = `${base}/${id}/${frame}/plan.fpln`;
        const plan = await reader.bytes(input);
        const metadata = JSON.parse(plan.bytes.subarray(32, 32 + plan.bytes.readUInt32LE(8)));
        assert.equal(metadata.slices[0].media_pixels.length, 0);
        const messages = (await reader.json(`${base}/${id}/${frame}/resources.json`)).filter((m) =>
          metadata.resources.includes(m.hash),
        );
        assert.deepEqual(messages.map((m) => m.hash).sort(), metadata.resources);
        for (const m of messages) await reader.bytes(`${base}/${id}/frame-resources/${m.hash}.bin`);
        const source = messages.find((m) => m.kind === "media_source");
        const media = messages.find((m) => m.kind === "media_frame");
        assert.equal(source.descriptor.media_kind, "sequence");
        assert.equal(media.descriptor.sample.kind, "sequence");
        const member = media.descriptor.sample.frame,
          asset = assets[member];
        assert(asset);
        const grant = {
          source: source.hash,
          sequence_frame: member,
          scope: source.descriptor.authorization_scope,
          path: asset.path,
          sha256: asset.sha256,
        };
        grants.set(`${source.hash}:${member}`, grant);
        const dir = join(context.output, id, String(frame));
        await mkdir(dir, { recursive: true });
        const resourceManifest = join(dir, "resources.json");
        await writeAtomicJson(resourceManifest, messages);
        await reader.bytes(local(resourceManifest));
        const job = {
          plan: join(context.root, input),
          resources: join(context.root, base, id, "frame-resources"),
          resource_manifest: resourceManifest,
          out: join(dir, "frame.png"),
        };
        jobs.push(job);
        inputs.push({
          item,
          frame,
          input,
          plan,
          source,
          media,
          grant,
          asset,
          job,
          meta: await reader.json(`${base}/${id}/${frame}/meta.json`),
        });
      }
    }
    assert.equal(inputs.length, 12);
    assert.equal(grants.size, 8);
    const authorization = join(context.output, "authorizations.json");
    await writeAtomicJson(authorization, [...grants.values()]);
    await reader.bytes(local(authorization));
    jobs.push(
      ...[...jobs]
        .reverse()
        .map((job, i) => ({ ...job, out: join(context.output, `reverse-${i}.png`) })),
    );
    const batch = join(context.output, "batch.json");
    await writeAtomicJson(batch, jobs);
    report.request = { path: local(batch), sha256: await hashFile(batch) };
    const common = [
      "--media-authorizations",
      authorization,
      "--ffmpeg",
      ffmpeg,
      ...(compiler ? ["--dxcompiler", compiler] : []),
    ];
    const step = await execute(
      {
        id: "native-sequence-batch",
        file: binary,
        args: ["render-plan", "--batch", batch, ...common],
        timeout_ms: 180_000,
      },
      context,
    );
    assert.equal(step.status, "passed", `Sequence execution failed: ${step.log}`);
    const receipts = (await readFile(join(context.root, step.log), "utf8"))
      .split(/\r?\n/)
      .filter((l) => l.startsWith('{"schema_version":'))
      .map((l) => JSON.parse(l));
    assert.equal(receipts.length, jobs.length);
    const candidate = { schema_version: 1, frames: [] },
      forward = [];
    for (const [i, receipt] of receipts.entries()) {
      const index = i < inputs.length ? i : jobs.length - 1 - i;
      const input = inputs[index],
        pixels = await reader.image(local(jobs[i].out));
      validateReceipt(receipt, {
        plan_sha256: input.plan.sha256,
        rgba_sha256: pixels.rgba_sha256,
        ...input.item.size,
        adapter: input.meta.adapter.gpuMemory.device,
      });
      assert.equal(receipt.native_image_decode, true);
      assert.equal(receipt.frame_index, i);
      assert.equal(receipt.renderer_reused, i > 0);
      assert.equal(receipt.native_images.length, 1);
      const decoded = receipt.native_images[0];
      assert.equal(decoded.source, input.source.hash);
      assert.equal(decoded.frame, input.media.hash);
      assert.equal(decoded.source_sha256, input.asset.sha256);
      assert.equal(decoded.backend, "ffmpeg-sequence-snapshot");
      assert.equal(decoded.width, input.asset.width);
      assert.equal(decoded.height, input.asset.height);
      assert.equal(decoded.format, "rgba8unorm-srgb");
      assert(receipt.image_cache.resident_bytes > 0);
      if (i < inputs.length) {
        forward.push(pixels.rgba_sha256);
        candidate.frames.push({
          case_id: input.item.id,
          frame: input.frame,
          path: relative(context.output, jobs[i].out).replaceAll("\\", "/"),
          png_sha256: pixels.png_sha256,
        });
        report.frames.push({
          case_id: input.item.id,
          frame: input.frame,
          member: input.grant.sequence_frame,
          input: { path: input.input, sha256: input.plan.sha256 },
          grant: input.grant,
          receipt,
          output: { path: local(jobs[i].out), sha256: pixels.png_sha256 },
        });
      } else {
        assert.equal(pixels.rgba_sha256, forward[index]);
        assert.equal(receipt.image_cache.uploads, receipts[inputs.length - 1].image_cache.uploads);
      }
    }
    for (let i = 0; i < 8; i += 2) assert.equal(forward[i], forward[i + 1]);
    assert.equal(new Set(forward.slice(8)).size, 4);
    const uniqueFrames = new Map(inputs.map((input) => [input.media.hash, input.media.descriptor]));
    const decodeCache = receipts.at(-1).media_decode_cache;
    assert.equal(decodeCache.decodes, uniqueFrames.size);
    assert.equal(decodeCache.misses, uniqueFrames.size);
    assert.equal(decodeCache.hits, jobs.length - uniqueFrames.size);
    assert.equal(decodeCache.entries, uniqueFrames.size);
    assert.equal(decodeCache.evictions, 0);
    assert.equal(
      decodeCache.resident_bytes,
      [...uniqueFrames.values()].reduce(
        (bytes, frame) => bytes + frame.width * frame.height * 4,
        0,
      ),
    );
    report.decode_cache = decodeCache;
    report.batch = { step, receipts, frames: jobs.length, reverse_exact: 12, hold_pairs_exact: 4 };
    const first = inputs[0],
      grant = first.grant,
      wrong = assets[1];
    report.rejections = await runStillRejections(
      context,
      {
        binary,
        grant,
        args: [
          "render-plan",
          "--plan",
          first.job.plan,
          "--resources",
          first.job.resources,
          "--resource-manifest",
          first.job.resource_manifest,
          ...common,
        ],
        extraRejections: [
          ["wrong-member", [{ ...grant, sequence_frame: 1 }], [], /source or scope is not granted/],
          [
            "unscoped-member",
            [{ ...grant, sequence_frame: null }],
            [],
            /source or scope is not granted/,
          ],
          [
            "wrong-member-bytes",
            [{ ...grant, path: wrong.path, sha256: wrong.sha256 }],
            [],
            /source identity differs/,
          ],
        ],
      },
      execute,
    );
    const candidatePath = join(context.output, "candidate.json");
    await writeAtomicJson(candidatePath, candidate);
    report.candidate_manifest = {
      path: local(candidatePath),
      sha256: await hashFile(candidatePath),
    };
    report.pixels = await runPixelGate(
      { ...context, output: join(context.output, "pixels") },
      { manifestPath: candidatePath, scope: "diagnostic", profileOverride: "gpu" },
      execute,
    );
    assert.equal(report.pixels.status, "passed", "Native sequence pixels need acceptance");
    assert.equal(await hashFile(ffmpeg), report.ffmpeg.sha256);
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
