import assert from "node:assert/strict";

export const deliveryDocuments = [
  "docs/ARCHITECTURE.md",
  "docs/RENDER_QUEUE.md",
  "docs/MEDIA_BACKENDS.md",
  "docs/BENCHMARKS.md",
  "docs/PRODUCTION_RENDER_CONTRACT.md",
];

/** The delivery task owns semantic review; immutable pins keep that review synchronized at exit. */
export async function auditDeliveryDocuments(reader, milestone) {
  const review = milestone.tasks.find((t) => t.id === "M12-T8").documentation;
  assert.equal(review?.status, "passed", "Delivery documentation review is required");
  assert.equal(new Set(review.files.map((f) => f.path)).size, review.files.length);
  for (const path of deliveryDocuments)
    assert(
      review.files.some((f) => f.path === path),
      path,
    );
  for (const file of review.files) await reader.bytes(file.path, file.sha256);
  return review;
}

export async function auditProductionRetirement(reader, gate, performance) {
  const packaged = await reader.json(gate.evidence.package.path, gate.evidence.package.sha256);
  assert.equal(packaged.status, "passed");
  assert.equal(packaged.archive_sha256, gate.packaged_app.sha256);
  assert.equal(packaged.boundary.schema_version, 1);
  assert.equal(packaged.boundary.reference, false);
  assert.deepEqual(packaged.boundary.retained_modules, []);
  await reader.bytes(gate.packaged_app.path, gate.packaged_app.sha256);
  const queue = await reader.json(gate.evidence.queue.path, gate.evidence.queue.sha256);
  assert.equal(queue.status, "passed");
  assert.deepEqual(queue.host_ipc, []);
  assert.deepEqual(queue.retired_ipc_registrations, []);
  assert.equal(queue.native_jobs_cleaned, true);
  assert.deepEqual(
    queue.outputs.map((o) => o.kind),
    ["still", "pngSequence", "mp4"],
  );
  assert.equal(queue.launches.length, 3);
  assert.equal(queue.persisted_jobs.length, 3);
  assert.equal(new Set(queue.outputs.map((o) => o.id)).size, 3);
  for (const item of queue.outputs) {
    assert.equal(item.result.status, "completed");
    assert.equal(queue.persisted_jobs.find((job) => job.id === item.id)?.status, "completed");
    assert.equal(queue.launches.filter((job) => job.jobId === item.id).length, 1);
  }
  assert.equal(queue.png.first_frame_exact, true);
  assert.equal(queue.png.sequence_frames, 12);
  assert.equal(gate.outputs.length, 14);
  assert.equal(new Set(gate.outputs.map((f) => f.path)).size, 14);
  for (const file of gate.outputs) await reader.bytes(file.path, file.sha256);
  const cli = performance.native_binaries.find((f) => f.path.endsWith("/aster-render-cli.exe"));
  assert(cli);
  assert.equal(cli.sha256, gate.preview.packaged_renderer.sha256);
  await reader.bytes(cli.path, cli.sha256);
  return { status: "passed", output_kinds: queue.outputs.map((o) => o.kind), native_jobs: 3 };
}
