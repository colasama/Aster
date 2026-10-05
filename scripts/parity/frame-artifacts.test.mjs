import assert from "node:assert/strict";
import test from "node:test";
import { loadIrRuntime } from "../migration/ir-gate-runtime.mjs";
import { artifactHash, FrameArtifactStore, validateFrameArtifacts } from "./frame-artifacts.mjs";

test("frame artifact audit binds plans, native receipt, binary resources and exact pixels", async (t) => {
  const runtime = await loadIrRuntime(process.cwd());
  t.after(() => runtime.close());
  const fixture = runtime.frameBundleFixtures()[1];
  const plan = structuredClone(fixture.frameBundle.plan);
  const header = plan.metadata.header;
  header.snapshot_scope = `capture:${"a".repeat(64)}`;
  const bytes = Buffer.from(runtime.encodeFramePlan(plan.metadata, plan.blobs));
  const resources = fixture.frameBundle.resources;
  const sha = artifactHash(bytes);
  const files = new Map(
    Object.entries({
      "0/plan.fpln": bytes,
      "0/replay.fpln": bytes,
      "0/replay.rust.fpln": bytes,
      "0/resources.json": Buffer.from(JSON.stringify(resources.map((p) => p.message))),
      "0/rust.json": Buffer.from(
        JSON.stringify({
          kind: "ir_bundle",
          status: "passed",
          submitted_sha256: sha,
          replay_sha256: sha,
          roundtrip_sha256: sha,
          resources: resources.length,
          resource_bytes: resources.reduce((n, p) => n + p.bytes.length, 0),
        }),
      ),
    }),
  );
  const proof = Object.fromEntries(
    [...files].map(([path, value]) => [path.slice(2), artifactHash(value)]),
  );
  for (const packet of resources)
    files.set(`frame-resources/${packet.message.hash}.bin`, Buffer.from(packet.bytes));
  const source = { ir_cli_sha256: "b".repeat(64) };
  const item = { composition: header.composition_id, size: header.target, aa: header.aa };
  const meta = {
    frame: 0,
    case_sha256: "a".repeat(64),
    frame_rate: {
      numerator: header.frame_rate.numerator,
      denominator: header.frame_rate.denominator,
    },
    time: runtime.frameTimeToNumber(header.time),
    rgba_sha256: "c".repeat(64),
    frame_replay: { exact: true, production_sha256: "c".repeat(64), replay_sha256: "c".repeat(64) },
    frame_plan: { schema_version: 1, ir_cli_sha256: source.ir_cli_sha256, files: proof },
  };
  const read = async (path) => {
    assert(files.has(path), "Missing artifact");
    return files.get(path);
  };
  const audit = (value = meta) => validateFrameArtifacts(read, value, item, source);
  assert.equal((await audit()).status, "passed");
  const original = files.get("0/plan.fpln");
  files.delete("0/plan.fpln");
  await assert.rejects(audit(), /Missing artifact/);
  files.set("0/plan.fpln", Buffer.from(original));
  files.get("0/plan.fpln")[0] ^= 1;
  await assert.rejects(audit(), /Frame artifact changed/);
  files.set("0/plan.fpln", original);
  const packet = resources.find((p) => p.bytes.length);
  const path = `frame-resources/${packet.message.hash}.bin`;
  const payload = files.get(path);
  files.set(path, Buffer.from(payload));
  files.get(path)[0] ^= 1;
  await assert.rejects(audit(), /Frame resource content changed/);
  files.set(path, payload);
  await assert.rejects(audit({ ...meta, frame_replay: undefined }), /Missing exact/);
  await assert.rejects(
    audit({ ...meta, frame_plan: { ...meta.frame_plan, ir_cli_sha256: "d".repeat(64) } }),
    /validator binary changed/,
  );
  assert.throws(
    () => new FrameArtifactStore({}).consume({ caseId: "case", frame: 0 }),
    /Missing prepared/,
  );
});
