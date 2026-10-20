import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomicJson } from "../migration/report.mjs";
import { hashFile } from "../migration/source.mjs";
import { CaptureStore } from "./capture-store.mjs";
import { artifactHash, validateFrameArtifacts } from "./frame-artifacts.mjs";
import { writePlanProjectSnapshot } from "./plan-project-snapshot.mjs";
import { validatePlanSampleSchedule } from "./plan-samples.mjs";

/** Plan-only samples have a separate evidence schema and never enter pixel reference caches. */
export class PlanCaptureStore extends CaptureStore {
  constructor(config, host) {
    super(config, host);
    assert.equal(config.planReferences, true);
    this.projects = new Map();
    this.projectSnapshots = new Map();
    this.resourceCaches = new Map();
  }

  async cached() {
    return false;
  }

  async writeFrame() {
    throw new Error("Plan references cannot contain pixel evidence");
  }

  async writePlan(assignment, payload) {
    assert.equal(payload.caseId, assignment.case.id);
    const schedule = assignment.planSamples;
    assert(schedule && Number.isSafeInteger(payload.frame));
    const sample = schedule.samples[payload.frame];
    assert(sample && sample.index === payload.frame);
    assert.equal(payload.time, sample.time);
    assert.deepEqual(payload.frameRate, schedule.frame_rate);
    const collected = this.frames.get(assignment.case.id) ?? new Map();
    assert(!collected.has(payload.frame), "Duplicate plan sample");
    const directory = join(this.config.runDirectory, "pending", assignment.case.id);
    if (payload.frame === 0) {
      assert(payload.project && !this.projects.has(assignment.case.id));
      const composition = payload.project.compositions.find(
        (c) => c.id === assignment.case.composition,
      );
      assert(composition, "Loaded project has no addressed composition");
      validatePlanSampleSchedule(
        schedule,
        assignment.case,
        composition,
        assignment.inputs.project_sha256,
      );
      const bytes = Buffer.from(JSON.stringify(payload.project));
      assert(bytes.length <= 64 * 1024 * 1024, "Loaded project exceeds input budget");
      this.projectSnapshots.set(
        assignment.case.id,
        await writePlanProjectSnapshot(this.config, assignment.case, bytes),
      );
      this.projects.set(assignment.case.id, artifactHash(bytes));
    } else {
      assert.equal(payload.project, undefined, "Loaded project changed within the case");
      assert(this.projects.has(assignment.case.id), "Missing loaded project snapshot");
    }
    const meta = {
      schema_version: 1,
      kind: "ts-plan-sample",
      case_id: assignment.case.id,
      frame: payload.frame,
      sample,
      time: payload.time,
      frame_rate: payload.frameRate,
      size: assignment.case.size,
      aa: assignment.case.aa,
      case_sha256: assignment.caseHash,
      frame_plan: this.plans.consume(payload),
      project_sha256: this.projects.get(assignment.case.id),
      renderer_source_sha256: this.config.source.renderer_source_sha256,
      adapter: payload.diagnostics,
    };
    const resources = this.resourceCaches.get(assignment.case.id) ?? new Map();
    this.resourceCaches.set(assignment.case.id, resources);
    await validateFrameArtifacts(
      (path) => readFile(join(directory, path)),
      meta,
      assignment.case,
      this.config.source,
      resources,
      { requirePixelReplay: false },
    );
    const path = join(directory, String(payload.frame), "meta.json");
    await writeAtomicJson(path, meta);
    collected.set(payload.frame, {
      frame: payload.frame,
      sample,
      meta_sha256: await hashFile(path),
    });
    this.frames.set(assignment.case.id, collected);
  }

  async completeCase(assignment, payload) {
    assert.equal(payload.caseId, assignment.case.id);
    const samples = this.frames.get(assignment.case.id);
    assert.equal(samples?.size, assignment.frames.length, "Plan samples are incomplete");
    await writeAtomicJson(
      join(this.config.runDirectory, "pending", assignment.case.id, "capture.json"),
      {
        schema_version: 1,
        kind: "ts-plan-reference",
        source_verified: false,
        case_id: assignment.case.id,
        inputs: assignment.inputs,
        project_sha256: this.projects.get(assignment.case.id),
        project_snapshot: this.projectSnapshots.get(assignment.case.id),
        samples: assignment.frames.map((frame) => {
          assert(samples.has(frame));
          return samples.get(frame);
        }),
        elapsed_ms: payload.elapsed_ms,
        diagnostics: payload.diagnostics,
      },
    );
    this.plans.releaseCase(assignment.case.id);
    this.resourceCaches.delete(assignment.case.id);
  }
}
