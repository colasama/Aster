import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

/** EXR has no browser import oracle; linear samples and the exact HDR shader check are separate gates. */
export async function runNativeExrGate(context, { base, binary, validateReceipt }, execute) {
  const report = {
    status: "failed",
    native_image_decode: true,
    format: "rgba16float",
    reference_boundary: "ts-exr-import",
    ts_pixel_parity: false,
  };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  let runtime;
  try {
    await mkdir(context.output, { recursive: true });
    runtime = await loadIrRuntime(context.root);
    const catalog = await reader.json("tests/parity/assets/media-assets.json");
    const asset = catalog.assets["pattern.exr"],
      encoded = Buffer.from(asset.data, "base64");
    assert.equal(sha256(encoded), asset.sha256);
    const sourceFile = join(context.output, "pattern.exr");
    await writeFile(sourceFile, encoded, { flag: "wx" });
    await reader.bytes(local(sourceFile), asset.sha256);
    const original = await reader.bytes(`${base}/media-png/0/plan.fpln`);
    const originalPlan = runtime.decodeFramePlan(original.bytes);
    const messages = (await reader.json(`${base}/media-png/0/resources.json`)).filter((message) =>
      originalPlan.metadata.resources.includes(message.hash),
    );
    const originals = new Map(messages.map((message) => [message.hash, message]));
    const originalSource = messages.find((message) => message.kind === "media_source");
    const originalFrame = messages.find((message) => message.kind === "media_frame");
    let left = 0x811c9dc5,
      right = 0x9e3779b9;
    for (const byte of encoded) {
      left = Math.imul(left ^ byte, 0x01000193);
      right = Math.imul(right ^ byte, 0x85ebca6b);
    }
    const identity = `fnv64:${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}:${encoded.length}`;
    const remapped = new Map();
    const payloads = join(context.output, "resources");
    await mkdir(payloads);
    const store = async (old, descriptor, bytes) => {
      const content = { kind: old.kind, descriptor };
      const hash = runtime.contentResourceHashSync(content, bytes);
      const message = { type: "put_resource", ...content, hash };
      await writeFile(join(payloads, `${hash}.bin`), bytes, { flag: "wx" });
      remapped.set(old.hash, message);
      return message;
    };
    const source = await store(
      originalSource,
      { ...originalSource.descriptor, content_identity: identity },
      new Uint8Array(),
    );
    const frame = await store(
      originalFrame,
      {
        ...originalFrame.descriptor,
        source: source.hash,
        format: "rgba16float",
        width: asset.width,
        height: asset.height,
      },
      new Uint8Array(),
    );
    const visiting = new Set();
    const rewrite = async (bytes) => {
      const plan = runtime.decodeFramePlan(bytes);
      for (const dependency of plan.metadata.resources) await resolve(dependency);
      const metadata = JSON.parse(JSON.stringify(plan.metadata), (_key, value) =>
        typeof value === "string" && remapped.has(value) ? remapped.get(value).hash : value,
      );
      metadata.resources.sort();
      return runtime.encodeFramePlan(metadata, plan.blobs);
    };
    const resolve = async (hash) => {
      if (remapped.has(hash)) return remapped.get(hash);
      assert(!visiting.has(hash), "Cyclic captured resource dependency");
      visiting.add(hash);
      const message = originals.get(hash);
      assert(message, "Missing captured resource");
      let { bytes } = await reader.bytes(`${base}/media-png/frame-resources/${hash}.bin`);
      if (bytes.subarray(0, 4).toString("ascii") === "FPLN") bytes = await rewrite(bytes);
      assert.equal(message.kind, "buffer");
      const result = await store(
        message,
        { ...message.descriptor, element_count: bytes.length, byte_length: bytes.length },
        bytes,
      );
      visiting.delete(hash);
      return result;
    };
    const planBytes = await rewrite(original.bytes);
    const planPath = join(context.output, "plan.fpln");
    await writeFile(planPath, planBytes, { flag: "wx" });
    const manifestPath = join(context.output, "resources.json");
    await writeAtomicJson(
      manifestPath,
      [...remapped.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
    );
    const authorization = join(context.output, "authorization.json");
    await writeAtomicJson(authorization, [
      {
        source: source.hash,
        scope: source.descriptor.authorization_scope,
        path: sourceFile,
        sha256: asset.sha256,
      },
    ]);
    for (const path of [planPath, manifestPath, authorization]) await reader.bytes(local(path));
    for (const message of remapped.values())
      await reader.bytes(local(join(payloads, `${message.hash}.bin`)));
    const output = join(context.output, "frame.png");
    report.step = await execute(
      {
        id: "native-exr-original-plan",
        file: binary,
        args: [
          "render-plan",
          "--plan",
          planPath,
          "--resources",
          payloads,
          "--media-authorizations",
          authorization,
          "--ffmpeg",
          join(context.root, "build/ffmpeg/ffmpeg.exe"),
          "--out",
          output,
        ],
        timeout_ms: 120_000,
      },
      context,
    );
    assert.equal(report.step.status, "passed");
    const receipt = JSON.parse(
      (await readFile(join(context.root, report.step.log), "utf8")).trim().split(/\r?\n/).at(-1),
    );
    const pixels = await reader.image(local(output));
    const meta = await reader.json(`${base}/media-png/0/meta.json`);
    validateReceipt(receipt, {
      plan_sha256: sha256(planBytes),
      rgba_sha256: pixels.rgba_sha256,
      width: pixels.width,
      height: pixels.height,
      adapter: meta.adapter.gpuMemory.device,
    });
    assert.equal(receipt.native_image_decode, true);
    assert.equal(receipt.native_images.length, 1);
    assert.equal(receipt.native_images[0].frame, frame.hash);
    assert.equal(receipt.native_images[0].source_sha256, asset.sha256);
    assert.equal(receipt.native_images[0].format, "rgba16float");
    assert.equal(receipt.native_images[0].backend, "rust-exr-snapshot");
    assert.equal(receipt.image_cache.resident_bytes, asset.width * asset.height * 8);
    assert.equal(receipt.image_cache.uploads, 1);
    report.receipt = receipt;
    report.output = { path: local(output), sha256: pixels.png_sha256 };
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  } finally {
    await runtime?.close();
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
