import assert from "node:assert/strict";
import test from "node:test";
import { captureMatchingPresentation } from "./preview-presentation-observer.mjs";

test("compositor observation rejects stale frames and timestamps arrival before pixel inspection", async () => {
  let clock = 10;
  let pending = 0;
  let captures = 0;
  const seen = [];
  const result = await captureMatchingPresentation({
    now: () => clock,
    expected: "target",
    capture: async () => {
      assert.equal(pending++, 0, "Compositor copies must not overlap");
      await Promise.resolve();
      clock += 2;
      pending--;
      return ++captures === 3 ? "target" : "previous";
    },
    identify: (frame, arrived) => {
      seen.push({ frame, arrived });
      clock += 3;
      return frame;
    },
  });
  assert.deepEqual(result, {
    capture_started_ms: 20,
    presentation_ms: 22,
    image_sha256: "target",
    capture_attempts: 3,
  });
  assert.deepEqual(
    seen.map((entry) => entry.arrived),
    [12, 17, 22],
  );
  assert.equal(captures, 3, "No copies are scheduled after the first matching frame");
});

test("timed-out compositor copies cannot accept late frames or schedule further requests", async () => {
  let complete;
  let captures = 0;
  let inspected = 0;
  const result = captureMatchingPresentation({
    capture: () => {
      captures++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    identify: () => {
      inspected++;
      return "target";
    },
    expected: "target",
    timeoutMs: 5,
  });
  await assert.rejects(result, /Matching compositor copy timed out/);
  complete("target");
  await Promise.resolve();
  assert.equal(captures, 1);
  assert.equal(inspected, 0);
});

test("capture and pixel-inspection failures are fatal instead of retried", async () => {
  for (const boundary of ["capture", "identify"]) {
    let captures = 0;
    await assert.rejects(
      captureMatchingPresentation({
        capture: async () => {
          captures++;
          if (boundary === "capture") throw new Error("capture failed");
          return "target";
        },
        identify: () => {
          throw new Error("identify failed");
        },
        expected: "target",
      }),
      new RegExp(`${boundary} failed`),
    );
    assert.equal(captures, 1);
  }
});
