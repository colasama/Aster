import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { validateCapturedRaster } from "../parity/raster-capture.mjs";

/** Bind actual GPU raster capture evidence and independently admit its binary resources in Rust. */
export async function auditCapturedRasters(reader, manifestPath, context, execute) {
  const manifest = await reader.json(manifestPath);
  const base = posix.dirname(manifestPath);
  const output = join(context.output, "raster-resources");
  await mkdir(output, { recursive: true });
  const cli = join(
    context.root,
    "target",
    "release",
    `aster-render-cli${process.platform === "win32" ? ".exe" : ""}`,
  );
  const origins = new Set();
  const checks = [];
  let resources = 0;
  let bytes = 0;
  let frames = 0;
  for (const item of manifest.cases) {
    const capture = await reader.json(`${base}/${item.path}`, item.capture_sha256);
    assert(Array.isArray(capture.raster_resources), "Candidate lacks raster capture evidence");
    const payloadHashes = new Set();
    const frameHashes = new Set();
    const transcript = [];
    for (const record of capture.raster_resources) {
      assert(/^[a-f0-9]{64}$/.test(record.pixel_hash));
      assert(
        !payloadHashes.has(record.pixel_hash) && !frameHashes.has(record.frame_hash),
        "Duplicate raster generation",
      );
      payloadHashes.add(record.pixel_hash);
      frameHashes.add(record.frame_hash);
      const prefix = `${base}/${item.case_id}/raster-resources/${record.pixel_hash}`;
      const messages = await reader.json(`${prefix}.json`, record.messages_sha256);
      const pixels = await reader.bytes(`${prefix}.bin`, record.pixels_sha256);
      const checked = validateCapturedRaster(messages, pixels.bytes, pixels.bytes);
      for (const [key, value] of Object.entries(checked))
        assert.equal(record[key], value, `Raster capture ${key} differs`);
      assert.equal(messages[0].descriptor.authorization_scope, `capture:${item.case_sha256}`);
      origins.add(record.origin);
      bytes += record.bytes;
      resources += 1;
      transcript.push(
        ...messages,
        ...messages
          .slice()
          .reverse()
          .map((m) => ({ type: "evict_resource", hash: m.hash })),
      );
    }
    for (const frame of capture.frames) {
      const meta = await reader.json(
        `${base}/${item.case_id}/${frame.frame}/meta.json`,
        frame.meta_sha256,
      );
      assert(Array.isArray(meta.raster_resources), "Frame lacks installed raster references");
      assert.equal(new Set(meta.raster_resources).size, meta.raster_resources.length);
      for (const hash of meta.raster_resources)
        assert(payloadHashes.has(hash), "Frame raster payload is absent");
      frames += 1;
    }
    if (!transcript.length) continue;
    const input = join(output, `${item.case_id}.input.json`);
    const destination = join(output, `${item.case_id}.output.json`);
    await writeFile(input, JSON.stringify(transcript), { flag: "wx" });
    const step = await execute(
      {
        id: `raster-${item.case_id}`,
        file: cli,
        args: [
          "ir",
          "resources",
          "--input",
          input,
          "--output",
          destination,
          "--payloads",
          join(context.root, base, item.case_id, "raster-resources"),
        ],
      },
      context,
    );
    assert.equal(step.status, "passed", "Rust rejected captured raster resources");
    assert.equal(step.exit_code, 0);
    const logical = posix.join(
      posix.relative(context.root.replaceAll("\\", "/"), output.replaceAll("\\", "/")),
      `${item.case_id}.output.json`,
    );
    assert.deepEqual(
      await reader.json(logical),
      transcript,
      "Rust captured-resource transcript differs",
    );
    checks.push({
      case_id: item.case_id,
      resources: capture.raster_resources.length,
      duration_ms: step.duration_ms,
      log: step.log,
    });
  }
  assert.deepEqual(
    [...origins].sort(),
    ["psd", "svg", "text"],
    "Full corpus must capture every raster origin",
  );
  return {
    status: "passed",
    resources,
    bytes,
    frames,
    origins: [...origins].sort(),
    exact_gpu_replay: true,
    checks,
  };
}
