import assert from "node:assert/strict";
import test from "node:test";
import { captureInitialPreview } from "./preview-readiness.mjs";

test("initial GPU readiness retry records the transient failure and successful capture", async () => {
  const attempts = [];
  let calls = 0;
  const preview = await captureInitialPreview(
    async () => {
      if (++calls === 1) {
        throw new Error(
          'render_preview: {"code":"execution_failed","message":"Renderer did not open a frame session","details":{}}',
        );
      }
      return { frames: [{ width: 320 }] };
    },
    attempts,
    { wait: async () => {} },
  );
  assert.equal(preview.frames[0].width, 320);
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed", "passed"],
  );
  assert(attempts.every((attempt) => Number.isFinite(attempt.duration_ms)));
});

test("persistent readiness failures stop at the bounded attempt count", async () => {
  const attempts = [];
  await assert.rejects(
    captureInitialPreview(
      async () => {
        throw new Error("render_preview: Renderer did not open a frame session");
      },
      attempts,
      { maximumAttempts: 2, wait: async () => {} },
    ),
    /Renderer did not open/,
  );
  assert.equal(attempts.length, 2);
});

test("unrelated rendering errors fail immediately without retry", async () => {
  const attempts = [];
  await assert.rejects(
    captureInitialPreview(async () => {
      throw new Error("render_preview: shader compilation failed");
    }, attempts),
    /shader compilation failed/,
  );
  assert.equal(attempts.length, 1);
});

test("structured MCP errors with another code are not treated as GPU readiness", async () => {
  const attempts = [];
  await assert.rejects(
    captureInitialPreview(async () => {
      throw new Error(
        'render_preview: {"code":"permission_denied","message":"Renderer did not open a frame session","details":{}}',
      );
    }, attempts),
    /permission_denied/,
  );
  assert.equal(attempts.length, 1);
});
