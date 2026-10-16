import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { encodeRgbaPng } from "../parity/png.mjs";
import { auditExportQuality } from "./export-quality.mjs";
import {
  exportReferencePlan,
  exportReferenceSamples,
  scoreExportSamples,
} from "./export-reference-samples.mjs";
import { runStep } from "./process.mjs";
import { hashFile } from "./source.mjs";

test("sparse sequence recovery includes neighbors outside the exported interval", () => {
  const assignment = {
    case: { frames: [2, 5], sequence: true },
    benchmark: { startFrame: 2, endFrameExclusive: 6 },
  };
  const composition = { duration: 1, frameRate: { numerator: 8, denominator: 1 } };
  assert.deepEqual(exportReferencePlan(assignment, composition), [
    { frame: 2, sequence: { frame: 2, first_frame: 0, last_frame: 7, previous: 1, next: 3 } },
    { frame: 5, sequence: { frame: 5, first_frame: 0, last_frame: 7, previous: 4, next: 6 } },
  ]);
  assignment.case.sequence = false;
  assignment.case.frames.reverse();
  assert.deepEqual(exportReferencePlan(assignment, composition), [
    { frame: 2, sequence: null },
    { frame: 5, sequence: null },
  ]);
});

test("dense addressed segments retain original frame identities and both interior neighbors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-export-reference-"));
  try {
    const rgba = Buffer.from([30, 60, 90, 255]);
    const png = encodeRgbaPng(1, 1, rgba);
    const inputs = {
      async reference(_item, frame) {
        assert(frame >= 714 && frame <= 716);
        return {
          path: String(frame),
          capture: { inputs: {} },
          meta: { rgba_sha256: createHash("sha256").update(rgba).digest("hex") },
        };
      },
      async bytes() {
        return { bytes: png };
      },
    };
    const assignment = {
      case: { id: "owner-main", frames: [714, 715, 716], size: { width: 1, height: 1 } },
      inputs: {},
      benchmark: { startFrame: 714, endFrameExclusive: 717 },
    };
    const result = await exportReferenceSamples(
      inputs,
      assignment,
      { duration: 100, frameRate: { numerator: 30, denominator: 1 } },
      directory,
    );
    assert.deepEqual(
      result.samples.map((s) => s.frame),
      [0, 1, 2],
    );
    const contexts = result.samples.map((s) => s.context.sequence);
    assert.deepEqual(
      contexts.map((s) => s.frame),
      [714, 715, 716],
    );
    assert(contexts.every((s) => s.first_frame === 714 && s.last_frame === 716));
    assert.equal(contexts[0].previous, null);
    assert.equal(contexts[2].next, null);
    assert.equal(contexts[1].previous, result.samples[0].path);
    assert.equal(contexts[1].next, result.samples[2].path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct YUV scoring selects sparse nonzero frames without duplicating EOF or hiding wrong frames", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-export-score-"));
  const root = process.cwd();
  try {
    for (let frame = 0; frame < 6; frame++) {
      const rgba = Buffer.alloc(128 * 72 * 4);
      for (let y = 0; y < 72; y++)
        for (let x = 0; x < 128; x++) {
          const at = (y * 128 + x) * 4;
          const value = (x + frame * 19) % 128 < 48 ? 220 : 24;
          rgba.set([value, value, value, 255], at);
        }
      await writeFile(join(directory, `input-${frame}.png`), encodeRgbaPng(128, 72, rgba));
    }
    const run = promisify(execFile);
    for (const [name, reverse] of [
      ["correct", false],
      ["wrong", true],
    ]) {
      await run(
        join(root, "build/ffmpeg/ffmpeg.exe"),
        [
          "-v",
          "error",
          "-framerate",
          "30",
          "-i",
          join(directory, "input-%d.png"),
          "-vf",
          `${reverse ? "reverse," : ""}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`,
          "-c:v",
          "libx264",
          "-qp",
          "0",
          "-threads",
          "1",
          join(directory, `${name}.mp4`),
        ],
        { windowsHide: true, timeout: 30000 },
      );
    }
    const samples = [1, 4].map((frame) => ({ frame, path: join(directory, `input-${frame}.png`) }));
    const correct = {
      path: join(directory, "correct.mp4"),
      sha256: await hashFile(join(directory, "correct.mp4")),
    };
    const wrong = {
      path: join(directory, "wrong.mp4"),
      sha256: await hashFile(join(directory, "wrong.mp4")),
    };
    for (const fallback of [false, true]) {
      for (const mismatch of [false, true]) {
        const output = join(
          directory,
          `${fallback ? "fallback" : "vmaf"}-${mismatch ? "mismatch" : "matched"}`,
        );
        await mkdir(output);
        const result = await scoreExportSamples(
          { root, output, env: process.env },
          samples,
          {
            native: mismatch ? wrong : correct,
            ts: correct,
          },
          async (command, context) => {
            const step = await runStep(command, context);
            if (fallback && command.id === "quality-filters") {
              // Simulate a build lacking libvmaf; execute the real fallback filters unchanged.
              const path = resolve(context.root, step.log);
              await writeFile(
                path,
                (await readFile(path, "utf8"))
                  .split("\n")
                  .filter((line) => !/\blibvmaf\b/.test(line))
                  .join("\n"),
              );
            }
            return step;
          },
        );
        assert.equal(result.method, fallback ? "ssim-psnr" : "vmaf");
        if (fallback) {
          assert.equal(result.ssim.ts, 1);
          assert.equal(result.psnr.ts, "inf");
          if (mismatch) assert(Number.isFinite(result.psnr.native));
        } else {
          assert(Number.isFinite(result.vmaf.ts));
          if (!mismatch) assert.equal(result.vmaf.native, result.vmaf.ts);
        }
        assert.equal(result.passed, !mismatch);
        const reader = {
          root,
          async bytes(path, sha) {
            const file = resolve(root, path);
            assert.equal(await hashFile(file), sha);
            return { bytes: await readFile(file) };
          },
        };
        await auditExportQuality(reader, result, samples.length);
        const tampered = structuredClone(result);
        tampered.evidence[0].sha256 = "0".repeat(64);
        await assert.rejects(auditExportQuality(reader, tampered, samples.length));
        await assert.rejects(auditExportQuality(reader, result, samples.length + 1));
        if (!fallback) {
          const log = JSON.parse(await readFile(resolve(output, "native-vmaf.json"), "utf8"));
          assert.equal(log.frames.length, samples.length);
        }
      }
    }
    const failedOutput = join(directory, "vmaf-execution-failed");
    await mkdir(failedOutput);
    const attempted = [];
    await assert.rejects(
      scoreExportSamples(
        { root, output: failedOutput, env: process.env },
        samples,
        { native: correct, ts: correct },
        async (command, context) => {
          attempted.push(command.id);
          if (command.id === "native-vmaf") return { status: "failed" };
          return runStep(command, context);
        },
      ),
      /native vmaf scoring failed/,
    );
    assert.deepEqual(attempted, ["quality-filters", "native-vmaf"]);
    const output = join(directory, "mutated");
    await mkdir(output);
    await assert.rejects(
      scoreExportSamples({ root, output, env: process.env }, samples, {
        native: { ...correct, sha256: "0".repeat(64) },
        ts: correct,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
