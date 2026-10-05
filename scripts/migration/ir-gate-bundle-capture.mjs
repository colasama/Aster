import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactHash } from "../parity/frame-artifacts.mjs";

/** Exercise the same native admission used before captured-frame TS replay. */
export async function auditBundleCapture(runtime, fixture, packets, directory, options) {
  const { cli, command, cliReport } = options;
  const encode = (plan) => runtime.encodeFramePlan(plan.metadata, plan.blobs);
  const submitted = structuredClone(fixture.frameBundle.plan);
  submitted.metadata.slices[0].media_pixels = [];
  new DataView(submitted.blobs[0].buffer).setUint32(16, 0, true);
  const submittedBytes = encode(submitted);
  const live = join(directory, "submitted.fpln");
  const replay = join(directory, "capture.fpln");
  const messages = join(directory, "resources.input.json");
  await writeFile(live, submittedBytes, { flag: "wx" });
  await writeFile(replay, fixture.bytes, { flag: "wx" });
  async function run(id, changes = {}, expectedCode = 0) {
    const output = join(directory, `capture-${id}.fpln`);
    const args = {
      input: replay,
      submitted: live,
      resources: messages,
      payloads: directory,
      ...changes,
      output,
    };
    const result = await command(
      `ir-bundle-${fixture.id}-${id}`,
      cli,
      ["ir", "bundle", ...Object.entries(args).flatMap(([key, value]) => [`--${key}`, value])],
      expectedCode,
    );
    const report = cliReport(result.log, expectedCode === 0 ? "ir_bundle" : undefined);
    if (expectedCode !== 0) await assert.rejects(access(output), { code: "ENOENT" });
    return { report, output };
  }
  const success = await run("accepted");
  assert.equal(success.report.submitted_sha256, artifactHash(submittedBytes));
  assert.equal(success.report.replay_sha256, artifactHash(fixture.bytes));
  assert.equal(success.report.roundtrip_sha256, artifactHash(fixture.bytes));
  assert.deepEqual(await readFile(success.output), Buffer.from(fixture.bytes));
  const missing = join(directory, "missing-resources.json");
  await writeFile(missing, JSON.stringify(packets.slice(1).map((p) => p.message)), { flag: "wx" });
  await run("missing", { resources: missing }, 2);
  const changed = structuredClone(submitted);
  changed.metadata.slices[0].shadow_map_size = 512;
  new DataView(changed.blobs[0].buffer).setUint32(0, 512, true);
  const changedPath = join(directory, "changed-submitted.fpln");
  await writeFile(changedPath, encode(changed), { flag: "wx" });
  await run("changed", { submitted: changedPath }, 2);
  const partial = packets.find((p) => p.message.hash === submitted.metadata.slices[0].scene);
  assert(partial);
  await run("discovery", { submitted: join(directory, `${partial.message.hash}.bin`) }, 2);
  const corrupt = join(directory, "corrupt-payloads");
  await mkdir(corrupt);
  let mutated = false;
  for (const packet of packets) {
    const bytes = Buffer.from(packet.bytes);
    if (!mutated && bytes.length) {
      bytes[0] ^= 1;
      mutated = true;
    }
    await writeFile(join(corrupt, `${packet.message.hash}.bin`), bytes, { flag: "wx" });
  }
  assert(mutated);
  await run("corrupt", { payloads: corrupt }, 2);
  return {
    exact: true,
    missing_rejected: true,
    execution_change_rejected: true,
    discovery_rejected: true,
    corrupt_rejected: true,
  };
}
