import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { createServer } from "vite";
import { qualifyProjectTextPlan } from "./native-project-text-plan.mjs";
import { loadQualifiedProjectText } from "./native-project-text-qualification.mjs";
import { hashFile } from "./source.mjs";

/** Keep qualified glyph identity comparison separate from untouched production captures. */
export class ProjectPlanComparison {
  constructor(context, reader, binary, execute) {
    this.context = context;
    this.reader = reader;
    this.binary = binary;
    this.execute = execute;
  }
  async compare(expected, sample, sampleIndex, frame, directory, job, receipt) {
    const { context, reader, execute } = this,
      { root, output } = context;
    const prepared = { binary: this.binary };
    const local = (path) => relative(root, path).replaceAll("\\", "/");
    let comparison = join(output, "comparisons", `${expected.id}-${sampleIndex}.json`);
    let step = await execute(
      {
        id: `plan-${expected.id}-${sampleIndex}`,
        file: prepared.binary,
        args: [
          "plan-diff",
          "--a",
          join(root, sample.reference_plan.path),
          "--a-resources",
          join(root, sample.reference_resources),
          "--b",
          join(directory, "plan.fpln"),
          "--b-resources",
          join(job.out, "resources"),
          "--out",
          comparison,
        ],
        timeout_ms: 120_000,
      },
      { ...context, print: undefined },
    );
    let measured = await reader.json(local(comparison));
    assert.equal(measured.a_sha256, sample.reference_plan.sha256);
    assert.equal(measured.b_sha256, frame.plan_sha256);
    assert.equal(step.exit_code, measured.equal ? 0 : 1);
    assert.equal(step.status, measured.equal ? "passed" : "failed");
    assert(!step.error && !step.signal);
    let nativeText;
    if (!measured.equal && frame.native_text_pixels?.length > 0) {
      if (!this.runtime) {
        this.qualification = await loadQualifiedProjectText(reader);
        this.runtime = await createServer({
          root,
          configFile: false,
          optimizeDeps: { noDiscovery: true, include: [] },
          server: { middlewareMode: true, watch: null, hmr: false, ws: false },
          appType: "custom",
        });
        this.codecs = {
          ...(await this.runtime.ssrLoadModule("/src/renderer/frame-plan/codec.ts")),
          ...(await this.runtime.ssrLoadModule("/src/renderer/frame-plan/resources.ts")),
        };
      }
      const raw = {
        comparison: { path: local(comparison), sha256: await hashFile(comparison) },
        step,
      };
      const substitution = await qualifyProjectTextPlan(
        context,
        reader,
        this.codecs,
        this.qualification,
        {
          case_id: expected.id,
          authored_sha256: receipt.project.authored_sha256,
          time: sample.sample.time,
          frame,
          reference: join(root, sample.reference_plan.path),
          reference_sha256: sample.reference_plan.sha256,
          reference_resources: join(root, sample.reference_resources),
          candidate: join(directory, "plan.fpln"),
          candidate_resources: join(job.out, "resources"),
          output: join(output, "qualified-text", expected.id, String(sampleIndex)),
        },
      );
      comparison = join(output, "comparisons", `${expected.id}-${sampleIndex}-qualified.json`);
      step = await execute(
        {
          id: `plan-${expected.id}-${sampleIndex}-qualified`,
          file: prepared.binary,
          args: [
            "plan-diff",
            "--a",
            join(root, sample.reference_plan.path),
            "--a-resources",
            join(root, sample.reference_resources),
            "--b",
            join(root, substitution.plan.path),
            "--b-resources",
            join(root, substitution.resources),
            "--out",
            comparison,
          ],
          timeout_ms: 120_000,
        },
        { ...context, print: undefined },
      );
      measured = await reader.json(local(comparison));
      nativeText = { raw, substitution };
    }
    assert.equal(measured.kind, "plan_diff");
    assert.equal(measured.a_sha256, sample.reference_plan.sha256);
    assert.equal(measured.b_sha256, nativeText?.substitution.plan.sha256 ?? frame.plan_sha256);
    assert.equal(measured.relative, 1e-5);
    assert.equal(measured.absolute, 1e-6);
    assert.equal(step.exit_code, measured.equal ? 0 : 1);
    assert.equal(step.status, measured.equal ? "passed" : "failed");
    assert(!step.error && !step.signal);
    return {
      sample: sample.sample,
      comparison: { path: local(comparison), sha256: await hashFile(comparison) },
      equal: measured.equal,
      step,
      ...(nativeText ? { native_text_substitution: nativeText } : {}),
    };
  }
  async close() {
    await this.runtime?.close();
  }
}
