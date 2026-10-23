import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { runNativeVideoSourceCacheGate } from "./native-video-source-cache-gate.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Reexecute authenticated video vectors under every source-cache mode on the current binary. */
export async function validateVideoStreaming(context, binary, fixtureReport) {
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const baseline = await reader.json(local(fixtureReport));
  assert.equal(baseline.status, "passed");
  const retained = baseline.modes.find((mode) => mode.id === "retained");
  assert(retained);
  const jobs = await reader.json(retained.request.path, retained.request.sha256);
  const command = retained.step.command;
  assert.equal(command[1], "render-plan");
  assert.equal(command[2], "--batch");
  const end = command.indexOf("--media-cache-bytes");
  assert(end > 4);
  const common = command.slice(4, end);
  const authorization = common[common.indexOf("--media-authorizations") + 1];
  assert(authorization);
  const grants = await reader.json(local(authorization));
  const inputs = [],
    receipts = [],
    pinned = new Map();
  const pin = async (path, expected) => {
    const evidence = await reader.bytes(local(path), expected);
    pinned.set(path, evidence.sha256);
    return evidence;
  };
  await pin(fixtureReport);
  await pin(join(context.root, retained.request.path), retained.request.sha256);
  await pin(authorization);
  for (const grant of grants) await pin(grant.path, grant.sha256);
  for (const index of [0, 2]) {
    const job = jobs[index];
    const messages = JSON.parse((await pin(job.resource_manifest)).bytes);
    const source = messages.find((message) => message.kind === "media_source");
    assert(source);
    await pin(job.plan);
    for (const resource of messages) await pin(join(job.resources, `${resource.hash}.bin`));
    const original = retained.frames[index];
    const image = await reader.image(original.output.path, original.output.sha256);
    assert.equal(image.rgba_sha256, original.receipt.rgba_sha256);
    inputs.push({ source, job });
    receipts.push(original.receipt);
  }
  const result = await runNativeVideoSourceCacheGate(context, {
    inputs,
    receipts,
    binary,
    common,
    reader,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.exact_comparisons, 24);
  for (const [path, digest] of pinned) assert.equal(await hashFile(path), digest);
  const report = {
    status: "passed",
    scope:
      "Current native video streaming across retained, disabled, byte-pressure and entry-pressure source caches; exact pixels, unchanged receipts and private-file cleanup",
    fixture_report: { path: fixtureReport, sha256: await hashFile(fixtureReport) },
    inputs: [...pinned].map(([path, sha256]) => ({ path, sha256 })),
    cache: result,
  };
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
