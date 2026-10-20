import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function auditNativeFileInputs(context, execute = runStep) {
  const reader = new M0Evidence(context.root),
    local = (p) => relative(context.root, p).replaceAll("\\", "/");
  const media = await reader.bytes(local(join(context.output, "project-media-frames-oracle.json")));
  const resources = await reader.bytes(local(join(context.output, "resource-request-oracle.json")));
  const original = JSON.parse(media.bytes),
    ordered = JSON.parse(resources.bytes);
  const cases = original.cases.map((c) => {
    const reference = ordered.cases.find((x) => x.id === c.id);
    assert(reference, c.id);
    const first = reference.samples[0];
    return {
      id: c.id,
      project: c.project,
      context: {
        ...first.context,
        surface: { ...first.context.surface, revision: 1 },
        layouts: reference.layouts,
      },
      samples: c.samples.map((s) => ({
        index: s.index,
        resources: s.resources,
        frame: {
          ...first.frame,
          compositionId: c.composition,
          time: s.time,
          snapshotScope: c.scope,
          projectRevision: 0,
        },
      })),
    };
  });
  const input = {
    ...original,
    cases,
    sources: [
      ...original.sources,
      ...ordered.sources,
      {
        path: local(join(context.output, "project-media-frames-oracle.json")),
        sha256: media.sha256,
      },
      {
        path: local(join(context.output, "resource-request-oracle.json")),
        sha256: resources.sha256,
      },
    ],
  };
  const path = join(context.output, "native-file-input-oracle.json"),
    reportPath = join(context.output, "native-file-input-observations.json");
  await writeAtomicJson(path, input);
  const proof = await reader.bytes(local(path));
  const steps = [];
  for (const control of [null, "stale-source"]) {
    let selected = path;
    if (control) {
      const value = {
        ...input,
        cases: [],
        sources: [{ ...input.sources[0], sha256: "0".repeat(64) }],
      };
      selected = join(context.output, "native-file-input-stale-source.json");
      await writeAtomicJson(selected, value);
      await reader.bytes(local(selected));
    }
    const step = await execute(
      {
        id: `native-file-input-${control ?? "decode"}`,
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-render-project",
          "--test",
          "file_media_oracle",
          "native_ordered_file_resources_match_ts",
          "--",
          "--ignored",
          "--exact",
        ],
      },
      {
        ...context,
        env: {
          ...context.env,
          ASTER_NATIVE_PROJECT_FILE_ORACLE: selected,
          ASTER_NATIVE_PROJECT_FILE_DECODE: "1",
          ASTER_NATIVE_PROJECT_FILE_REPORT: reportPath,
        },
      },
    );
    steps.push(step);
    assert(!step.error && !step.signal);
    assert.equal(step.exit_code, control ? 101 : 0);
    const log = (await reader.bytes(step.log)).bytes.toString("utf8");
    assert(
      control
        ? /test result: FAILED\. 0 passed; 1 failed; 0 ignored/.test(log)
        : /test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log),
    );
  }
  const report = await reader.bytes(local(reportPath)),
    observations = JSON.parse(report.bytes);
  assert.equal(observations.decoded_pixels, true);
  assert.equal(
    observations.observations.length,
    cases.reduce((n, c) => n + c.samples.length, 0),
  );
  return {
    status: "passed",
    scope: "native-ordered-file-input-acquisition",
    pixel_parity_acceptance: false,
    cases: cases.length,
    samples: observations.observations.length,
    oracle: { path: local(path), sha256: proof.sha256 },
    observations: { path: local(reportPath), sha256: report.sha256 },
    steps,
    checked_files: await reader.stable(),
  };
}
