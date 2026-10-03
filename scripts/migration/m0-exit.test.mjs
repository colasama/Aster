import assert from "node:assert/strict";
import test from "node:test";
import { auditCaptureSet } from "./m0-captures.mjs";
import { auditM0Exit } from "./m0-exit.mjs";
import { captured, fixture, oracle } from "./m0-exit-fixtures.mjs";
import { auditComparison, auditOracle } from "./m0-pixels.mjs";

test("capture audit validates raw pixels and refuses missing adjacent frames or changed source", async (t) => {
  const f = await fixture(t);
  const valid = await captured(f);
  const result = await auditCaptureSet(f.reader(), valid.corpus, "refs", valid.source);
  assert.equal(result.frames.size, 3);
  const provenance = {
    run_id: "new-run",
    source: { tree_sha256: "c".repeat(64) },
    host: { cacheIdentity: { device: "fixture" } },
    caseStatus: new Map([["sequence", "cached"]]),
  };
  assert.equal(
    (await auditCaptureSet(f.reader(), valid.corpus, "refs", valid.source, undefined, provenance))
      .frames.size,
    3,
  );
  provenance.caseStatus.set("sequence", "passed");
  await assert.rejects(
    auditCaptureSet(f.reader(), valid.corpus, "refs", valid.source, undefined, provenance),
  );
  for (const options of [{ omitNeighbor: true }, { wrongSource: true }]) {
    const data = await captured(f, options);
    await assert.rejects(auditCaptureSet(f.reader(), data.corpus, "refs", data.source));
  }
  await captured(f);
  await f.write("refs/sequence/1/frame.png", "corrupt");
  await assert.rejects(auditCaptureSet(f.reader(), valid.corpus, "refs", valid.source), /SHA-256/);
});

test("exact audit binds actual RGBA, declared sequence coverage, and artifact bytes", async (t) => {
  const f = await fixture(t);
  const value = await oracle(f);
  const run = () =>
    auditComparison(
      f.reader(),
      value.positive.gate,
      "exact",
      true,
      value.references,
      new Map([["shape-ellipse/0", value.positive.candidate]]),
      "c".repeat(64),
    );
  assert.equal((await run()).size, 1);
  value.positive.candidate.rgba_sha256 = "d".repeat(64);
  await assert.rejects(run());
  value.positive.candidate.rgba_sha256 = value.references.get("shape-ellipse/0").rgba_sha256;
  value.references.get("shape-ellipse/0").sequence = true;
  await assert.rejects(run(), /Sequence evidence/);
  value.references.get("shape-ellipse/0").sequence = false;
  value.positive.gate.frames.push(value.positive.gate.frames[0]);
  await assert.rejects(run());
  value.positive.gate.frames.pop();
  await f.write(value.positive.evidence.heatmap, "changed");
  await assert.rejects(run(), /SHA-256/);
});

test("oracle audit replays deliberate pixels and requires a bound rejected self-review", async (t) => {
  const f = await fixture(t);
  const value = await oracle(f);
  const run = () =>
    auditOracle(f.reader(), value.ledger, value.task, value.references, "c".repeat(64));
  assert.equal((await run()).changed_pixels, 400);
  value.ledger.self_reviews[0].verdict = "accepted";
  await assert.rejects(run());
  value.ledger.self_reviews[0].verdict = "rejected";
  value.ledger.self_reviews[0].metrics = { exact: false };
  await assert.rejects(run());
});

test("M0 cannot exit with completed task labels but absent full candidate evidence", async (t) => {
  const f = await fixture(t);
  await f.json("docs/migration/rust-renderer-progress.json", {
    milestones: [
      {
        id: "M0",
        tasks: Array.from({ length: 6 }, (_, index) => ({
          id: `M0-T${index + 1}`,
          status: "done",
        })),
      },
    ],
  });
  await assert.rejects(auditM0Exit(f.root), /M0 exit requires exactReportPath/);
});
