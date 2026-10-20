import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const artifactHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

export function validateFrameResource(message, bytes) {
  assert.equal(message.type, "put_resource");
  assert(/^[a-f0-9]{64}$/.test(message.hash), "Invalid frame resource hash");
  const json = Buffer.from(canonical({ kind: message.kind, descriptor: message.descriptor }));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  assert.equal(
    createHash("sha256")
      .update("ASTER_RESOURCE_V1\0")
      .update(length)
      .update(json)
      .update(bytes)
      .digest("hex"),
    message.hash,
    "Frame resource content changed",
  );
}

function frameMetadata(bytes) {
  assert(bytes.length >= 32 && bytes.subarray(0, 4).toString() === "FPLN", "Missing FPLN header");
  assert.equal(bytes.readUInt32LE(20), bytes.length);
  const metadata = JSON.parse(bytes.subarray(32, 32 + bytes.readUInt32LE(8)).toString());
  assert.equal(metadata.renderer_plan_complete, true, "Submitted frame plan is incomplete");
  assert.equal(
    metadata.contract_level,
    "frame_bundle_slice_v1",
    "Expected submitted executable frame bundle",
  );
  return metadata;
}

/** Read through the caller's contained, hash-tracked evidence reader. */
export async function validateFrameArtifacts(
  read,
  meta,
  item,
  source,
  resourceCache = new Map(),
  { requirePixelReplay = true } = {},
) {
  const proof = meta.frame_plan;
  assert(proof?.schema_version === 1, "Missing submitted frame artifact evidence");
  assert.equal(proof.ir_cli_sha256, source.ir_cli_sha256, "Frame validator binary changed");
  assert(/^[a-f0-9]{64}$/.test(proof.ir_cli_sha256));
  const prefix = `${meta.frame}/`;
  const files = {};
  for (const [name, hash] of Object.entries(proof.files)) {
    assert(
      ["plan.fpln", "replay.fpln", "replay.rust.fpln", "resources.json", "rust.json"].includes(
        name,
      ),
    );
    files[name] = await read(`${prefix}${name}`);
    assert.equal(artifactHash(files[name]), hash, `Frame artifact changed: ${name}`);
  }
  assert.equal(Object.keys(files).length, 5, "Incomplete frame artifacts");
  assert(files["replay.fpln"].equals(files["replay.rust.fpln"]), "Rust frame roundtrip differs");
  const submitted = frameMetadata(files["plan.fpln"]);
  const replay = frameMetadata(files["replay.fpln"]);
  assert.deepEqual(submitted.header, replay.header);
  const header = submitted.header;
  assert.equal(header.snapshot_scope, `capture:${meta.case_sha256}`);
  assert.equal(header.composition_id, item.composition);
  assert.deepEqual(header.target, item.size);
  assert.equal(header.aa, item.aa);
  assert.equal(header.frame_rate.kind, "rational");
  assert.equal(
    header.frame_rate.numerator * meta.frame_rate.denominator,
    meta.frame_rate.numerator * header.frame_rate.denominator,
  );
  const time = header.time;
  const seconds =
    time.kind === "binary_rational"
      ? (time.negative ? -1 : 1) * time.significand * 2 ** time.exponent
      : time.value / time.scale;
  assert.equal(seconds, meta.time, "Frame plan time differs");
  const report = JSON.parse(files["rust.json"].toString());
  assert.equal(report.kind, "ir_bundle");
  assert.equal(report.status, "passed");
  assert.equal(report.submitted_sha256, proof.files["plan.fpln"]);
  assert.equal(report.replay_sha256, proof.files["replay.fpln"]);
  assert.equal(report.roundtrip_sha256, proof.files["replay.rust.fpln"]);
  const messages = JSON.parse(files["resources.json"].toString());
  assert.equal(messages.length, report.resources);
  assert.deepEqual(messages.map((m) => m.hash).sort(), replay.resources);
  let resourceBytes = 0;
  for (const message of messages) {
    const existing = resourceCache.get(message.hash);
    if (existing) {
      assert.deepEqual(existing.message, message, "Resource descriptor changed");
      resourceBytes += existing.length;
      continue;
    }
    assert(/^[a-f0-9]{64}$/.test(message.hash));
    const bytes = await read(`frame-resources/${message.hash}.bin`);
    validateFrameResource(message, bytes);
    resourceCache.set(message.hash, { message, length: bytes.length });
    resourceBytes += bytes.length;
  }
  assert.equal(resourceBytes, report.resource_bytes);
  if (requirePixelReplay) {
    assert.equal(meta.frame_replay?.exact, true, "Missing exact native-roundtrip TS replay");
    assert.equal(meta.frame_replay.production_sha256, meta.rgba_sha256);
    assert.equal(meta.frame_replay.replay_sha256, meta.rgba_sha256);
  }
  return report;
}

export class FrameArtifactStore {
  #prepared = new Map();
  #resources = new Map();
  constructor(config) {
    this.config = config;
  }

  async prepare(assignment, payload) {
    assert.equal(payload.caseId, assignment.case.id);
    assert(/^[a-z0-9-]+$/.test(payload.caseId));
    assert(Number.isSafeInteger(payload.frame) && assignment.frames.includes(payload.frame));
    const key = `${payload.caseId}/${payload.frame}`;
    assert(!this.#prepared.has(key), "Duplicate frame preparation");
    const directory = join(this.config.runDirectory, "pending", payload.caseId);
    const frame = join(directory, String(payload.frame));
    const resources = join(directory, "frame-resources");
    await mkdir(frame, { recursive: true });
    await mkdir(resources, { recursive: true });
    const submitted = Buffer.from(payload.submitted);
    const replay = Buffer.from(payload.replay);
    assert(submitted.length <= 64 * 1024 * 1024 && replay.length <= 64 * 1024 * 1024);
    frameMetadata(submitted);
    frameMetadata(replay);
    assert(Array.isArray(payload.resources) && payload.resources.length <= 65536);
    const known = this.#resources.get(payload.caseId) ?? new Map();
    this.#resources.set(payload.caseId, known);
    let total = 0;
    const messages = [];
    for (const { message, bytes: input } of payload.resources) {
      const bytes = Buffer.from(input);
      total += bytes.length;
      assert(total <= 64 * 1024 * 1024, "Frame resources exceed capture budget");
      validateFrameResource(message, bytes);
      const fingerprint = canonical(message);
      if (known.has(message.hash)) assert.equal(known.get(message.hash), fingerprint);
      else {
        await writeFile(join(resources, `${message.hash}.bin`), bytes, { flag: "wx" });
        known.set(message.hash, fingerprint);
      }
      messages.push(message);
    }
    const files = {
      "plan.fpln": submitted,
      "replay.fpln": replay,
      "resources.json": Buffer.from(JSON.stringify(messages)),
    };
    for (const [name, bytes] of Object.entries(files))
      await writeFile(join(frame, name), bytes, { flag: "wx" });
    const cli = join(
      this.config.root,
      "target",
      "release",
      `aster-render-cli${process.platform === "win32" ? ".exe" : ""}`,
    );
    const { stdout } = await execute(
      cli,
      [
        "ir",
        "bundle",
        "--input",
        join(frame, "replay.fpln"),
        "--submitted",
        join(frame, "plan.fpln"),
        "--resources",
        join(frame, "resources.json"),
        "--payloads",
        resources,
        "--output",
        join(frame, "replay.rust.fpln"),
      ],
      { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    files["replay.rust.fpln"] = await readFile(join(frame, "replay.rust.fpln"));
    assert(files["replay.rust.fpln"].equals(replay));
    const report = JSON.parse(stdout);
    assert.equal(report.status, "passed");
    files["rust.json"] = Buffer.from(JSON.stringify(report));
    await writeFile(join(frame, "rust.json"), files["rust.json"], { flag: "wx" });
    const proof = {
      schema_version: 1,
      ir_cli_sha256: this.config.source.ir_cli_sha256,
      files: Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [name, artifactHash(bytes)]),
      ),
    };
    const receipt = {
      submitted_sha256: proof.files["plan.fpln"],
      replay_sha256: proof.files["replay.rust.fpln"],
    };
    this.#prepared.set(key, { proof, receipt });
    return { plan: new Uint8Array(files["replay.rust.fpln"]), receipt };
  }

  releaseCase(caseId) {
    assert(
      ![...this.#prepared.keys()].some((key) => key.startsWith(`${caseId}/`)),
      "Cannot release unconsumed plan receipts",
    );
    this.#resources.delete(caseId);
  }

  consume(payload) {
    const key = `${payload.caseId}/${payload.frame}`;
    const prepared = this.#prepared.get(key);
    assert(prepared, "Missing prepared native frame plan");
    assert.deepEqual(payload.framePlan, prepared.receipt, "Frame replay receipt differs");
    this.#prepared.delete(key);
    return prepared.proof;
  }
}
