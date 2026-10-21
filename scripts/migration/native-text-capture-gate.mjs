import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Exercise published project captures in a separate process with no native recipe inputs. */
export async function runNativeTextCaptureGate(context, input, expected, binary, execute) {
  const report = { status: "failed", frames: [], steps: [] };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const request = join(context.output, "request.json");
    const captured = join(context.output, "capture");
    const samples = input.samples.slice(0, 4);
    assert.equal(samples.length, 4);
    await writeAtomicJson(request, {
      settings: {
        resources: {
          visualization: "beauty",
          locale: input.locale,
          layouts: {},
          surface: { revision: 1, maxTextureDimension: 4096, memoryBudgetMb: 512, renderScale: 1 },
          maximumRasterDimension: 4096,
          maximumRasterPixels: 67_108_864,
        },
        selectedLayerId: null,
        shadowMapSize: 1024,
      },
      frames: samples.map(({ time }) => ({
        frame: {
          snapshotScope: `native-text:${input.project_sha256}`,
          projectRevision: 1,
          compositionId: input.composition,
          time,
          target: input.size,
          renderTarget: input.size,
          antiAliasing: "off",
          shadowsEnabled: true,
        },
        rasters: null,
      })),
    });
    const runtime = [
      "--backend",
      "dx12",
      "--dxcompiler",
      join(context.root, "node_modules/electron/dist/dxcompiler.dll"),
      "--layer-cache-bytes",
      "0",
      "--effect-pipeline-entries",
      "0",
    ];
    const captureStep = await execute(
      {
        id: "capture-native-text",
        file: binary,
        args: [
          "render-project",
          "--project",
          input.project,
          "--request",
          request,
          "--out",
          captured,
          "--ffmpeg",
          join(context.root, "build/ffmpeg/ffmpeg.exe"),
          "--ffprobe",
          join(context.root, "build/ffmpeg/ffprobe.exe"),
          ...runtime,
        ],
      },
      context,
    );
    report.steps.push(captureStep);
    assert.equal(captureStep.status, "passed");
    const receiptPath = local(join(captured, "report.json"));
    const receipt = await reader.json(receiptPath);
    report.receipt = { path: receiptPath, sha256: await hashFile(join(context.root, receiptPath)) };
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.project.authored_sha256, input.project_sha256);
    assert.equal(receipt.request_sha256, await hashFile(request));
    assert.equal(receipt.frames.length, samples.length);
    const jobs = [];
    for (const [index, frame] of receipt.frames.entries()) {
      const directory = join(captured, String(index));
      assert.equal(frame.index, index);
      assert.deepEqual(frame.text_routes, expected[index].routes);
      assert.equal(frame.native_text_pixels.length, 1);
      assert.equal(frame.native_text_pixels[0].frame, frame.text_routes[0].frame);
      assert.equal(frame.rgba_sha256, expected[index].frame_rgba_sha256);
      await reader.bytes(local(join(directory, "submitted.fpln")), frame.submitted_plan_sha256);
      await reader.bytes(local(join(directory, "plan.fpln")), frame.plan_sha256);
      const image = await reader.image(local(join(directory, "candidate.png")), frame.png_sha256);
      assert.equal(image.rgba_sha256, frame.rgba_sha256);
      const pixels = await reader.bytes(
        local(join(captured, "resources", `${frame.native_text_pixels[0].pixels}.bin`)),
      );
      assert.equal(pixels.sha256, expected[index].rgba_sha256);
      const closure = await execute(
        {
          id: `capture-closure-${index}`,
          file: binary,
          args: [
            "ir",
            "bundle",
            "--input",
            join(directory, "plan.fpln"),
            "--submitted",
            join(directory, "submitted.fpln"),
            "--resources",
            join(directory, "resources.json"),
            "--payloads",
            join(captured, "resources"),
            "--output",
            join(context.output, `roundtrip-${index}.fpln`),
          ],
        },
        context,
      );
      report.steps.push(closure);
      assert.equal(closure.status, "passed");
      await reader.bytes(local(join(context.output, `roundtrip-${index}.fpln`)), frame.plan_sha256);
      jobs.push({
        plan: join(directory, "plan.fpln"),
        resources: join(captured, "resources"),
        out: join(context.output, `replay-${index}.png`),
      });
      report.frames.push({
        index,
        rgba_sha256: frame.rgba_sha256,
        submitted_plan_sha256: frame.submitted_plan_sha256,
        replay_plan_sha256: frame.plan_sha256,
        routes: frame.text_routes,
        native_text_pixels: frame.native_text_pixels,
      });
    }
    const batch = join(context.output, "replay-jobs.json");
    await writeAtomicJson(batch, jobs);
    const replayStep = await execute(
      {
        id: "replay-native-text",
        file: binary,
        args: ["render-plan", "--batch", batch, ...runtime],
      },
      context,
    );
    report.steps.push(replayStep);
    assert.equal(replayStep.status, "passed");
    for (const [index, job] of jobs.entries()) {
      const image = await reader.image(local(job.out));
      assert.equal(image.rgba_sha256, report.frames[index].rgba_sha256);
    }
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
