import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadIrRuntime } from "../migration/ir-gate-runtime.mjs";
import { artifactHash } from "./frame-artifacts.mjs";
import { writePlanProjectSnapshot } from "./plan-project-snapshot.mjs";
import { publishPlanReferences } from "./plan-reference-publication.mjs";
import { planSampleSchedule } from "./plan-samples.mjs";
import { digest } from "./provenance.mjs";

for (const owner of [false, true])
  test(`plan publication binds every time with ${owner ? "external owner" : "local fixture"} snapshots`, async (t) => {
    const runtime = await loadIrRuntime(process.cwd());
    t.after(() => runtime.close());
    const root = await mkdtemp(join(tmpdir(), "aster-plan-reference-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = runtime.frameBundleFixtures()[1].frameBundle;
    const item = {
      id: "plan-test",
      project: owner ? "env:ASTER_PERF_PROJECT" : "tests/fixture.json",
      composition: fixture.plan.metadata.header.composition_id,
      frames: [0],
      size: fixture.plan.metadata.header.target,
      aa: fixture.plan.metadata.header.aa,
    };
    const composition = {
      id: item.composition,
      duration: 2,
      frameRate: { numerator: 30, denominator: 1 },
    };
    const project = { compositions: [composition] };
    const projectBytes = Buffer.from(JSON.stringify(project)),
      projectHash = artifactHash(projectBytes);
    const schedule = planSampleSchedule(item, composition, projectHash);
    const frames = schedule.samples.map((s) => s.index);
    const inputs = { case: item, project_sha256: projectHash, frames, plan_samples: schedule };
    const assignment = {
      case: item,
      caseHash: digest(inputs),
      frames,
      inputs,
      planSamples: schedule,
    };
    const runDirectory = join(root, "artifacts", "parity", "runs", "test");
    const directory = join(runDirectory, "pending", item.id);
    await mkdir(join(root, "tests", "parity"), { recursive: true });
    await writeFile(
      join(root, "tests", "parity", "corpus.json"),
      JSON.stringify({ cases: [item] }),
    );
    await mkdir(join(directory, "frame-resources"), { recursive: true });
    const source = {
      tree_sha256: "a".repeat(64),
      renderer_source_sha256: "b".repeat(64),
      ir_cli_sha256: "c".repeat(64),
    };
    const config = {
      root,
      runDirectory,
      runId: "test",
      planReferences: true,
      assignments: [assignment],
      source,
      ownerSnapshotDirectory: owner
        ? await mkdtemp(join(tmpdir(), "aster-owner-reference-"))
        : undefined,
    };
    if (config.ownerSnapshotDirectory)
      t.after(() => rm(config.ownerSnapshotDirectory, { recursive: true, force: true }));
    const report = {
      status: "passed",
      source_unchanged: true,
      exit_code: 0,
      run_id: "test",
      source,
      source_after: source,
      selected_cases: [item.id],
      cases: [{ id: item.id, status: "passed" }],
      host: { cacheIdentity: { fonts: { status: "available", sha256: "d".repeat(64) } } },
    };
    const capture = {
      schema_version: 1,
      kind: "ts-plan-reference",
      case_id: item.id,
      source_verified: false,
      inputs,
      project_sha256: projectHash,
      project_snapshot: await writePlanProjectSnapshot(config, item, projectBytes),
      samples: [],
    };
    for (const packet of fixture.resources)
      await writeFile(
        join(directory, "frame-resources", `${packet.message.hash}.bin`),
        packet.bytes,
      );
    for (const sample of schedule.samples) {
      const plan = structuredClone(fixture.plan);
      plan.metadata.header.snapshot_scope = `capture:${assignment.caseHash}`;
      plan.metadata.header.time = runtime.frameTimeFromNumber(sample.time);
      plan.metadata.header.frame_rate = { kind: "rational", numerator: 30, denominator: 1 };
      const bytes = Buffer.from(runtime.encodeFramePlan(plan.metadata, plan.blobs)),
        sha = artifactHash(bytes);
      const artifacts = {
        "plan.fpln": bytes,
        "replay.fpln": bytes,
        "replay.rust.fpln": bytes,
        "resources.json": Buffer.from(JSON.stringify(fixture.resources.map((p) => p.message))),
        "rust.json": Buffer.from(
          JSON.stringify({
            kind: "ir_bundle",
            status: "passed",
            submitted_sha256: sha,
            replay_sha256: sha,
            roundtrip_sha256: sha,
            resources: fixture.resources.length,
            resource_bytes: fixture.resources.reduce((n, p) => n + p.bytes.length, 0),
          }),
        ),
      };
      const path = join(directory, String(sample.index));
      await mkdir(path);
      for (const [name, bytes] of Object.entries(artifacts))
        await writeFile(join(path, name), bytes);
      const meta = {
        kind: "ts-plan-sample",
        frame: sample.index,
        sample,
        case_id: item.id,
        time: sample.time,
        frame_rate: composition.frameRate,
        case_sha256: assignment.caseHash,
        project_sha256: projectHash,
        renderer_source_sha256: source.renderer_source_sha256,
        frame_plan: {
          schema_version: 1,
          ir_cli_sha256: source.ir_cli_sha256,
          files: Object.fromEntries(
            Object.entries(artifacts).map(([n, b]) => [n, artifactHash(b)]),
          ),
        },
      };
      const metaBytes = Buffer.from(JSON.stringify(meta));
      await writeFile(join(path, "meta.json"), metaBytes);
      capture.samples.push({ frame: sample.index, sample, meta_sha256: artifactHash(metaBytes) });
    }
    const capturePath = join(directory, "capture.json");
    await writeFile(capturePath, JSON.stringify({ ...capture, samples: capture.samples.slice(1) }));
    await assert.rejects(publishPlanReferences(config, report));
    await writeFile(capturePath, JSON.stringify(capture));
    const metaPath = join(directory, "1", "meta.json");
    const original = await readFile(metaPath);
    const changed = JSON.parse(original);
    changed.time += 0.001;
    const changedBytes = Buffer.from(JSON.stringify(changed));
    await writeFile(metaPath, changedBytes);
    const badCapture = structuredClone(capture);
    badCapture.samples[1].meta_sha256 = artifactHash(changedBytes);
    await writeFile(capturePath, JSON.stringify(badCapture));
    await assert.rejects(publishPlanReferences(config, report));
    await writeFile(metaPath, original);
    await writeFile(capturePath, JSON.stringify(capture));
    const published = await publishPlanReferences(config, report);
    assert.equal(published.samples, 65);
    assert.equal(JSON.parse(await readFile(published.manifest)).kind, "ts-plan-reference");
    if (owner)
      await assert.rejects(
        readFile(join(runDirectory, "plan-reference", item.id, "project.json")),
        {
          code: "ENOENT",
        },
      );
    await assert.rejects(
      readFile(join(root, "artifacts", "parity", "reference", item.id, "capture.json")),
      { code: "ENOENT" },
    );
  });
