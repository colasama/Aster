import assert from "node:assert/strict";
import test from "node:test";
import { assertM9PixelCommand } from "./m9-pixels.mjs";

test("pixel exit rejects substituted comparator inputs and unsuccessful original execution", () => {
  const command = ["cli", "compare", "--reference", "frozen.png", "--candidate", "native.png"];
  const step = { id: "pixel-case-0", status: "passed", exit_code: 0, command };
  assertM9PixelCommand(step, command, step.id);
  for (const change of [
    { command: [...command.slice(0, -1), "retained-ts.png"] },
    { command: [...command, "--tolerance", "unapproved"] },
    { exit_code: 1 },
    { signal: "SIGTERM" },
    { id: "pixel-case-1" },
  ])
    assert.throws(() => assertM9PixelCommand({ ...step, ...change }, command, step.id));
});
