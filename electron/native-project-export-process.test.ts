import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import {
  NativeProjectExportCancelled,
  NativeProjectExportProcess,
} from "./native-project-export-process.js";
import {
  type NativeProjectExportExpectation,
  parseNativeProjectReceipt,
} from "./native-project-export-protocol.js";

const expected: NativeProjectExportExpectation = {
  format: "png",
  projectSha256: "a".repeat(64),
  output: "output.png",
  width: 2,
  height: 1,
  frameRate: { numerator: 30000, denominator: 1001 },
  startFrame: 3,
  frames: 1,
  bitrate: 20000000,
  includeAudio: false,
};
const time = (3 * 1001) / 30000;
const bits = Buffer.alloc(8);
bits.writeDoubleBE(time);
const receipt = {
  schema_version: 1,
  status: "passed",
  format: "png",
  project: { authored_sha256: expected.projectSha256, runtime_sha256: "b".repeat(64) },
  size: { width: 2, height: 1 },
  frame_rate: expected.frameRate,
  output: expected.output,
  report: { frames: 1, elapsed_ms: 1 },
  images: [
    {
      index: 0,
      member: null,
      time,
      time_bits: bits.toString("hex"),
      rgba_sha256: "c".repeat(64),
      png_sha256: "d".repeat(64),
      bytes: 80,
    },
  ],
};
const progress = { stage: "render", rendered_frames: 1, total_frames: 1, elapsed_ms: 1 };
const children: NativeProjectExportProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.dispose()));
});

function run(
  script: string,
  onEvent?: ConstructorParameters<typeof NativeProjectExportProcess>[0]["onEvent"],
) {
  const child = new NativeProjectExportProcess({
    executable: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      `import {createInterface} from 'node:readline';
       const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
       const lines=createInterface({input:process.stdin});
       lines.on('line',line=>{if(JSON.parse(line).action==='cancel')process.exit(0)});
       ${script}`,
    ],
    expected,
    onEvent,
  });
  children.push(child);
  return child;
}

test("a valid receipt cannot complete before native process close", async () => {
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const child = run(
    `send(${JSON.stringify(progress)});send(${JSON.stringify(receipt)});setTimeout(()=>process.exit(0),200);`,
    () => observed(),
  );
  let completed = false;
  void child.completion.then(() => {
    completed = true;
  });
  await started;
  await delay(25);
  expect(completed).toBe(false);
  expect(await child.completion).toMatchObject({ status: "passed" });
});

test("process rejects incomplete, forged, duplicate and unsuccessful completion", async () => {
  for (const script of [
    "process.exit(0)",
    `send(${JSON.stringify(progress)});send(${JSON.stringify({ ...receipt, output: "other.png" })});`,
    `send(${JSON.stringify(progress)});send(${JSON.stringify(receipt)});send(${JSON.stringify(receipt)});`,
    `send(${JSON.stringify(progress)});send(${JSON.stringify(receipt)});process.exit(2);`,
    `send(${JSON.stringify(progress)});process.stdout.write('{');process.exit(0);`,
    `send(${JSON.stringify(progress)});send({...${JSON.stringify(progress)},rendered_frames:0});`,
  ]) {
    await expect(run(script).completion).rejects.toThrow();
  }
});

test("pause acknowledgements are correlated and cancellation waits for exit", async () => {
  const paused: number[] = [];
  const child = run(
    `lines.on('line',line=>{const c=JSON.parse(line);if(c.action==='pause'){
       send({stage:'paused',request_id:c.request_id+10});
       send({stage:'paused',request_id:c.request_id});
       send({stage:'paused',request_id:c.request_id});
     }});`,
    (event) => {
      if (event.stage === "paused") paused.push(event.request_id);
    },
  );
  child.control("pause");
  child.control("resume");
  await delay(100);
  expect(paused).toEqual([]);
  child.control("pause");
  await expect.poll(() => paused, { timeout: 2000 }).toEqual([2]);
  child.control("cancel");
  await expect(child.completion).rejects.toBeInstanceOf(NativeProjectExportCancelled);
  await child.dispose();
});

test("image receipts bind the exact rational time, member and hashes", () => {
  for (const change of [
    { time: time + 0.001 },
    { time_bits: "0".repeat(16) },
    { member: "../frame.png" },
    { png_sha256: "wrong" },
    { index: 1 },
  ]) {
    expect(() =>
      parseNativeProjectReceipt(
        { ...receipt, images: [{ ...receipt.images[0], ...change }] },
        expected,
      ),
    ).toThrow();
  }
});

test("spawn failure settles without leaving an export lease pending", async () => {
  const child = new NativeProjectExportProcess({
    executable: "missing-aster-native-export-executable",
    args: [],
    expected,
  });
  children.push(child);
  await expect(child.completion).rejects.toThrow();
});
