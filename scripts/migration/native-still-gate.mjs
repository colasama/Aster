import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStillRejections } from "./native-still-rejections.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Original plans must resolve authorized files without captured pixel attachments. */
export async function runNativeStillGate(
  context,
  { base, binary, validateReceipt },
  execute = runStep,
) {
  const report = { status: "failed", native_image_decode: true, frames: [] };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const catalog = await reader.json("tests/parity/assets/media-assets.json");
    const corpus = await reader.json("tests/parity/corpus.json");
    const ffmpeg = join(context.root, "build", "ffmpeg", "ffmpeg.exe");
    report.ffmpeg = { path: local(ffmpeg), sha256: await hashFile(ffmpeg) };
    const candidate = { schema_version: 1, frames: [] };
    let rejectionInput;
    for (const [id, name] of [
      ["media-png", "pattern.png"],
      ["media-jpg", "pattern.jpg"],
    ]) {
      const asset = catalog.assets[name];
      assert(asset, `Missing still fixture: ${name}`);
      const sourcePath = join(context.output, name);
      await writeFile(sourcePath, Buffer.from(asset.data, "base64"), { flag: "wx" });
      await reader.bytes(local(sourcePath), asset.sha256);
      const item = corpus.cases.find((entry) => entry.id === id);
      for (const frame of item.frames) {
        const input = `${base}/${id}/${frame}/plan.fpln`;
        const plan = await reader.bytes(input);
        const metadata = JSON.parse(plan.bytes.subarray(32, 32 + plan.bytes.readUInt32LE(8)));
        assert.equal(metadata.slices[0].media_pixels.length, 0);
        const messages = (await reader.json(`${base}/${id}/${frame}/resources.json`)).filter(
          (message) => metadata.resources.includes(message.hash),
        );
        assert.deepEqual(messages.map((message) => message.hash).sort(), metadata.resources);
        for (const message of messages)
          await reader.bytes(`${base}/${id}/frame-resources/${message.hash}.bin`);
        const source = messages.find((message) => message.kind === "media_source");
        const media = messages.find((message) => message.kind === "media_frame");
        const dir = join(context.output, id, String(frame));
        await mkdir(dir, { recursive: true });
        const resourceManifest = join(dir, "resources.json");
        const authorization = join(dir, "authorization.json");
        await writeAtomicJson(resourceManifest, messages);
        const grant = {
          source: source.hash,
          scope: source.descriptor.authorization_scope,
          path: sourcePath,
          sha256: asset.sha256,
        };
        await writeAtomicJson(authorization, [grant]);
        await reader.bytes(local(resourceManifest));
        await reader.bytes(local(authorization));
        const output = join(dir, "frame.png");
        const args = [
          "render-plan",
          "--plan",
          input,
          "--resources",
          `${base}/${id}/frame-resources`,
          "--resource-manifest",
          resourceManifest,
          "--media-authorizations",
          authorization,
          "--ffmpeg",
          ffmpeg,
        ];
        rejectionInput ??= { binary, args, grant };
        const step = await execute(
          {
            id: `decode-${id}-${frame}`,
            file: binary,
            args: [...args, "--out", output],
            timeout_ms: 120_000,
          },
          context,
        );
        assert.equal(step.status, "passed", `Native still failed: ${step.log}`);
        const receipt = JSON.parse(
          (await readFile(join(context.root, step.log), "utf8")).trim().split(/\r?\n/).at(-1),
        );
        const pixels = await reader.image(local(output));
        const meta = await reader.json(`${base}/${id}/${frame}/meta.json`);
        validateReceipt(receipt, {
          plan_sha256: plan.sha256,
          rgba_sha256: pixels.rgba_sha256,
          ...item.size,
          adapter: meta.adapter.gpuMemory.device,
        });
        assert.equal(receipt.native_image_decode, true);
        assert.equal(receipt.native_images.length, 1);
        const decoded = receipt.native_images[0];
        assert.equal(decoded.source, source.hash);
        assert.equal(decoded.frame, media.hash);
        assert.equal(decoded.source_sha256, asset.sha256);
        assert.equal(decoded.width, asset.width);
        assert.equal(decoded.height, asset.height);
        assert.match(decoded.rgba_sha256, /^[a-f0-9]{64}$/);
        assert.equal(
          decoded.backend,
          process.platform === "win32" && name === "pattern.png"
            ? "windows-wic-png-snapshot"
            : "ffmpeg-still-snapshot",
        );
        assert(receipt.image_cache.uploads > 0);
        candidate.frames.push({
          case_id: id,
          frame,
          path: relative(context.output, output).replaceAll("\\", "/"),
          png_sha256: pixels.png_sha256,
        });
        report.frames.push({
          case_id: id,
          frame,
          step,
          receipt,
          input: { path: input, sha256: plan.sha256 },
          output: { path: local(output), sha256: pixels.png_sha256 },
        });
      }
    }
    const candidatePath = join(context.output, "candidate.json");
    await writeAtomicJson(candidatePath, candidate);
    report.candidate_manifest = {
      path: local(candidatePath),
      sha256: await hashFile(candidatePath),
    };
    report.rejections = await runStillRejections(context, rejectionInput, execute);
    report.pixels = await runPixelGate(
      { ...context, output: join(context.output, "pixels") },
      { manifestPath: candidatePath, scope: "diagnostic", profileOverride: "gpu" },
      execute,
    );
    assert.equal(report.pixels.status, "passed", "Native decoded pixels need acceptance");
    assert.equal(await hashFile(ffmpeg), report.ffmpeg.sha256);
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
