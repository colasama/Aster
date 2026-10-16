import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sourceProvenance } from "./source.mjs";

test("execution identity permits ledger-only reviews but invalidates executable and documentation changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-export-source-"));
  try {
    const git = (...args) =>
      execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
    git("init");
    await mkdir(join(root, "docs/migration"), { recursive: true });
    const ledger = join(root, "docs/migration/rust-renderer-progress.json");
    await writeFile(ledger, "{}");
    await writeFile(join(root, "renderer.js"), "one");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "🧪 Test source identity fixture",
    );
    const before = await sourceProvenance(root);
    await writeFile(ledger, '{"self_reviews":[]}');
    const review = await sourceProvenance(root);
    assert.notEqual(review.source_sha256, before.source_sha256);
    assert.equal(review.execution_sha256, before.execution_sha256);
    await writeFile(join(root, "renderer.js"), "two");
    const changed = await sourceProvenance(root);
    assert.notEqual(changed.execution_sha256, before.execution_sha256);
    await writeFile(join(root, "docs/contract.md"), "new contract");
    assert.notEqual((await sourceProvenance(root)).execution_sha256, changed.execution_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
