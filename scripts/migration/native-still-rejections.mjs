import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomicJson } from "./report.mjs";

/** Authorization and allocation failures must never publish a rendered frame. */
export async function runStillRejections(
  context,
  {
    binary,
    args,
    grant,
    extraRejections = [],
    sourceBudget = "--still-max-source-bytes",
    pixelBudget = "--still-max-pixel-bytes",
    pixelPattern = /decoded still exceeds extent or byte budget/,
  },
  execute,
) {
  const results = [];
  for (const [id, grants, extra, pattern] of [
    ["missing-grant", [], [], /source or scope is not granted/],
    ["wrong-scope", [{ ...grant, scope: "different-job" }], [], /source or scope is not granted/],
    ["wrong-sha", [{ ...grant, sha256: "0".repeat(64) }], [], /source identity differs/],
    ["source-budget", [grant], [sourceBudget, "16"], /source exceeds file byte budget/],
    ["pixel-budget", [grant], [pixelBudget, "16"], pixelPattern],
    ...extraRejections,
  ]) {
    const authorization = join(context.output, `reject-${id}.json`);
    await writeAtomicJson(authorization, grants);
    const command = [...args];
    command[command.indexOf("--media-authorizations") + 1] = authorization;
    const output = join(context.output, `rejected-${id}.png`);
    const step = await execute(
      {
        id: `still-reject-${id}`,
        file: binary,
        args: [...command, ...extra, "--out", output],
        timeout_ms: 60_000,
      },
      context,
    );
    assert.equal(step.exit_code, 2);
    assert.equal(step.status, "failed");
    const error = JSON.parse(
      (await readFile(join(context.root, step.log), "utf8")).trim().split(/\r?\n/).at(-1),
    );
    assert.match(error.error, pattern);
    await assert.rejects(stat(output), { code: "ENOENT" });
    results.push({ id, rejected: true, output_unchanged: true, step, error: error.error });
  }
  return results;
}
