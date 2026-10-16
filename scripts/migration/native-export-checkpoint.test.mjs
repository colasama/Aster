import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditExportCheckpoint,
  exportCaseFiles,
  reviewExportCase,
} from "./native-export-checkpoint.mjs";
import { hashFile } from "./source.mjs";

test("export self-review binds frame addresses, pixels, metrics and visual evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-export-review-"));
  try {
    for (const name of ["reference.png", "candidate.png", "contact.png", "heatmap.png"])
      await writeFile(join(root, name), name);
    const ledger = { self_reviews: [] };
    const entry = {
      id: "sample",
      frames: [30, 60],
      comparisons: [],
      audio: { passed: true },
      quality: { passed: true },
    };
    for (const arm of ["native", "ts"])
      for (const frame of entry.frames) {
        const c = {
          profile: { name: "yuv" },
          passed: true,
          metrics: { exact: false, psnr: 50 },
          structural: {},
          registration: {},
          sequence: null,
          ssim: {},
          checks: [{ id: "psnr", passed: true }],
          reference_rgba_sha256: "a".repeat(64),
          candidate_rgba_sha256: (arm === "native" ? "b" : "c").repeat(64),
        };
        const report = `${arm}-${frame}.json`;
        await writeFile(
          join(root, report),
          JSON.stringify({
            context: { case_id: entry.id },
            comparison: c,
            reference: {
              path: join(root, "reference.png"),
              png_sha256: await hashFile(join(root, "reference.png")),
            },
            candidate: {
              path: join(root, "candidate.png"),
              png_sha256: await hashFile(join(root, "candidate.png")),
            },
          }),
        );
        const report_sha256 = await hashFile(join(root, report));
        entry.comparisons.push({ ...c, name: arm, index: frame - 30, report, report_sha256 });
        ledger.self_reviews.push({
          ...c,
          frame,
          profile: "yuv",
          verdict: "accepted",
          residual_class: "decoder-rounding",
          evidence: {
            report,
            report_sha256,
            contact_sheet: "contact.png",
            contact_sheet_sha256: await hashFile(join(root, "contact.png")),
            heatmap: "heatmap.png",
            heatmap_sha256: await hashFile(join(root, "heatmap.png")),
          },
        });
      }
    assert.equal((await reviewExportCase(root, entry, ledger)).status, "passed");
    const seek = structuredClone(entry);
    seek.frames.reverse();
    assert.equal((await reviewExportCase(root, seek, ledger)).status, "passed");
    const unrelated = structuredClone(ledger.self_reviews[0]);
    const otherReport = JSON.parse(await readFile(join(root, unrelated.evidence.report), "utf8"));
    otherReport.context.case_id = "different-case-with-identical-pixels";
    await writeFile(join(root, "other.json"), JSON.stringify(otherReport));
    unrelated.evidence.report = "other.json";
    unrelated.evidence.report_sha256 = await hashFile(join(root, "other.json"));
    unrelated.verdict = "rejected";
    assert.equal(
      (await reviewExportCase(root, entry, { self_reviews: [...ledger.self_reviews, unrelated] }))
        .status,
      "passed",
    );
    unrelated.verdict = "accepted";
    assert.equal(
      (await reviewExportCase(root, entry, { self_reviews: [unrelated] })).status,
      "awaiting-self-review",
    );
    assert.equal(
      (await reviewExportCase(root, entry, { self_reviews: [] })).status,
      "awaiting-self-review",
    );
    const rejected = structuredClone(ledger);
    rejected.self_reviews[0].verdict = "rejected";
    assert.equal((await reviewExportCase(root, entry, rejected)).status, "failed");
    for (const mutate of [
      (e) => e.comparisons.pop(),
      (e) => {
        e.comparisons[1].index = 0;
      },
      (e) => {
        e.comparisons[0].metrics.psnr = 100;
      },
      (e) => {
        e.comparisons[0].passed = false;
      },
      (e) => {
        e.comparisons[0].name = "unknown";
      },
    ]) {
      const invalid = structuredClone(entry);
      mutate(invalid);
      await assert.rejects(reviewExportCase(root, invalid, ledger));
    }
    const wrong = structuredClone(ledger);
    wrong.self_reviews[0].structural = { changed: true };
    await assert.rejects(reviewExportCase(root, entry, wrong));
    await writeFile(join(root, "heatmap.png"), "changed");
    await assert.rejects(reviewExportCase(root, entry, ledger));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint authentication rejects code, input, reference and file drift before reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-export-checkpoint-"));
  try {
    await writeFile(join(root, "report.json"), "{}");
    const files = await exportCaseFiles(root, root);
    const checkpoint = {
      schema_version: 1,
      execution_sha256: "a".repeat(64),
      assignment: { inputs: 1 },
      reference_binding: { baseline: 1 },
      files,
      report: files[0],
    };
    const context = { root, source: { execution_sha256: "a".repeat(64) } };
    for (const mutate of [
      (c) => {
        c.execution_sha256 = "b".repeat(64);
      },
      (c) => {
        c.assignment.inputs = 2;
      },
      (c) => {
        c.reference_binding.baseline = 2;
      },
      (c) => {
        c.files[0].sha256 = "b".repeat(64);
      },
      (c) => {
        c.files.push(c.files[0]);
      },
      (c) => {
        c.files[0].path = "../escape.json";
      },
    ]) {
      const invalid = structuredClone(checkpoint);
      mutate(invalid);
      await assert.rejects(
        auditExportCheckpoint(
          context,
          invalid,
          checkpoint.assignment,
          checkpoint.reference_binding,
        ),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
