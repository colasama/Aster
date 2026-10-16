import assert from "node:assert/strict";
import test from "node:test";
import { materialReferenceFixture } from "./material-reference-fixture.mjs";
import {
  auditMaterialReferenceRepairs,
  materialRepairSelection,
} from "./material-reference-repair.mjs";

function fixture() {
  const kind = "material-ready-first-frame-reference-repair-v1";
  const ids = ["scene-lighting-directional", "scene-lighting-point", "scene-lighting-spot"];
  return {
    ledger: {
      owner_overrides: {
        material_reference_policy: {
          kind,
          approved: true,
          preserve_originals: true,
          other_quality_limits_unchanged: true,
          allowed_frames: ids.map((id) => `${id}/0`),
        },
      },
    },
    definitions: ids.map((id) => ({
      kind,
      case_id: id,
      frame: 0,
      directory: "capture",
      candidate_manifest: "capture/manifest.json",
      candidate_manifest_sha256: "a".repeat(64),
      capture_report: "report.json",
      capture_report_sha256: "b".repeat(64),
      renderer_source_sha256: "c".repeat(64),
    })),
  };
}

test("material correction selects only the three authorized first frames and leaves ordinary repairs alone", () => {
  const data = fixture();
  const ordinary = { case_id: "scene-particles-billboard", frame: 3 };
  assert.equal(materialRepairSelection({}, [ordinary]), null);
  const selected = materialRepairSelection(data.ledger, [ordinary, ...data.definitions]);
  assert.deepEqual(selected.selected, data.definitions);
});

test("material audit authenticates replacement pixels and preserves nine later frames and failed reviews", async (t) => {
  const f = await materialReferenceFixture(t);
  const result = await auditMaterialReferenceRepairs(
    f.reader(),
    f.ledger,
    f.corpus,
    f.original.frames,
    f.definitions,
  );
  assert.equal(result.size, 3);
  for (const entry of result.values())
    assert.equal(entry.evidence.original_comparison_verdict, "rejected");
});

test("material audit rejects tampered capture, unapproved pixels, source drift and changed later frames", async (t) => {
  const mutations = [
    async (f) => {
      f.manifest.source_verified = false;
      await f.json("candidate/manifest.json", f.manifest);
    },
    async (f) => {
      f.report.source_after = { ...f.report.source, tree_sha256: "f".repeat(64) };
      await f.json("capture-report.json", f.report);
      for (const d of f.definitions) d.capture_report_sha256 = await f.hash("capture-report.json");
    },
    async (f) => {
      f.proposal.affected[0].candidate_rgba_sha256 = "f".repeat(64);
      await f.json("proposal.json", f.proposal);
      f.ledger.owner_overrides.material_reference_policy.proposal.sha256 =
        await f.hash("proposal.json");
    },
    async (f) => {
      const key = "scene-lighting-directional";
      const capture = await f.reader().json(`refs/${key}/capture.json`);
      const first = await f.reader().bytes(`refs/${key}/0/frame.png`);
      const replacement = await f.reader().bytes(`candidate/${key}/0/frame.png`);
      assert.notDeepEqual(first.bytes, replacement.bytes);
      await f.write(`refs/${key}/15/frame.png`, replacement.bytes);
      capture.frames.find((x) => x.frame === 15).png_sha256 = replacement.sha256;
      await f.json(`refs/${key}/capture.json`, capture);
    },
    async (f) => {
      f.ledger.self_reviews[0].verdict = "accepted";
    },
  ];
  for (const [index, mutate] of mutations.entries())
    await t.test(String(index), async (t) => {
      const f = await materialReferenceFixture(t);
      await mutate(f);
      await assert.rejects(
        auditMaterialReferenceRepairs(
          f.reader(),
          f.ledger,
          f.corpus,
          f.original.frames,
          f.definitions,
        ),
      );
    });
});

test("missing authorization, expanded scope, duplicate addresses and mixed captures fail closed", () => {
  const mutations = [
    (d) => {
      delete d.ledger.owner_overrides;
    },
    (d) => {
      d.ledger.owner_overrides.material_reference_policy.approved = false;
    },
    (d) => {
      d.ledger.owner_overrides.material_reference_policy.preserve_originals = false;
    },
    (d) => {
      d.ledger.owner_overrides.material_reference_policy.other_quality_limits_unchanged = false;
    },
    (d) => {
      d.ledger.owner_overrides.material_reference_policy.allowed_frames.push("other/0");
    },
    (d) => {
      d.definitions.pop();
    },
    (d) => {
      d.definitions.push(d.definitions[0]);
    },
    (d) => {
      d.definitions[0].frame = 15;
    },
    (d) => {
      d.definitions[0].case_id = "other";
    },
    (d) => {
      d.definitions[0].capture_report = "other.json";
    },
    (d) => {
      d.definitions[0].candidate_manifest_sha256 = "d".repeat(64);
    },
    (d) => {
      d.definitions[0].renderer_source_sha256 = "d".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const data = fixture();
    mutate(data);
    assert.throws(() => materialRepairSelection(data.ledger, data.definitions));
  }
});
