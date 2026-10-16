import assert from "node:assert/strict";
import test from "node:test";
import { initializationCrashedBeforeBegin } from "./native-initialization-failure.mjs";

const failed = { exit_code: 0xc0000005, signal: null };
const capability = {
  type: "capabilities",
  encoder: { hardware_only: true, test_frame_verified: true },
};
const stored = { type: "resource_stored" };
function wire(responses) {
  return Buffer.from(
    responses
      .map(
        (response, index) =>
          `${JSON.stringify({ version: 1, request_id: index + 1, payload_bytes: 0, response })}\n`,
      )
      .join(""),
  );
}

test("only a verified hardware probe and complete resource prefix allow initialization recovery", () => {
  const bytes = wire([capability, stored, stored]);
  assert(initializationCrashedBeforeBegin(failed, bytes, 3));
  assert(initializationCrashedBeforeBegin({ ...failed, exit_code: -1073741819 }, bytes, 3));
  for (const step of [
    { exit_code: 0, signal: null },
    { exit_code: 1, signal: null },
    { exit_code: "3221225477", signal: null },
    { ...failed, signal: "SIGTERM" },
  ])
    assert.equal(initializationCrashedBeforeBegin(step, bytes, 3), false);
  for (const prefix of [0, 2, 4, 1.5])
    assert.equal(initializationCrashedBeforeBegin(failed, bytes, prefix), false);
});

test("post-begin crashes, malformed replies and unqualified encoders never recover", () => {
  for (const responses of [
    [capability, { type: "export_started" }],
    [capability, { type: "encoded", complete: false }],
    [capability, { type: "error", code: "hash_mismatch" }],
    [{ ...capability, encoder: { hardware_only: false, test_frame_verified: true } }, stored],
    [{ ...capability, encoder: { hardware_only: true, test_frame_verified: false } }, stored],
  ])
    assert.equal(initializationCrashedBeforeBegin(failed, wire(responses), 2), false);
  const bytes = wire([capability, stored]);
  for (const invalid of [
    bytes.subarray(0, bytes.length - 1),
    Buffer.from("invalid\n"),
    Buffer.from(bytes.toString().replace('"request_id":2', '"request_id":1')),
    Buffer.from(bytes.toString().replace('"payload_bytes":0', '"payload_bytes":1')),
    Buffer.from(bytes.toString().replace('"version":1', '"version":2')),
  ])
    assert.equal(initializationCrashedBeforeBegin(failed, invalid, 2), false);
});
