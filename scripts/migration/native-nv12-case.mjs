import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve, toNamespacedPath } from "node:path";
import { validateFrameArtifacts } from "../parity/frame-artifacts.mjs";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";
import { suppliedFrameRecord } from "./supplied-frame-inputs.mjs";

/** Raw-plane bounds isolate conversion rounding before the shared decoder's structural checks. */
export function nv12PlaneComparison(reference, candidate, size) {
  const { width, height } = size;
  assert(Number.isSafeInteger(width) && width > 0 && width % 2 === 0);
  assert(Number.isSafeInteger(height) && height > 0 && height % 2 === 0);
  const ySize = width * height;
  assert.equal(reference.length, (ySize * 3) / 2);
  assert.equal(candidate.length, reference.length);
  return [
    ["y", 0, ySize, 1],
    ["u", ySize, candidate.length, 2],
    ["v", ySize + 1, candidate.length, 2],
  ].map(([plane, start, end, stride]) => {
    let peak = 0,
      bias = 0,
      count = 0,
      different = 0;
    for (let index = start; index < end; index += stride) {
      const delta = candidate[index] - reference[index];
      peak = Math.max(peak, Math.abs(delta));
      bias += delta;
      count++;
      if (delta) different++;
    }
    return {
      plane,
      peak_error: peak,
      signed_bias: bias / count,
      different_samples: different,
      sample_count: count,
      passed: peak <= 1 && Math.abs(bias / count) <= 0.5,
    };
  });
}

/** Authenticate frozen supplied inputs before any batch reaches the GPU. */
export async function nv12CaseInputs(reader, item, source, base, manifest) {
  const captured = await reader.json(`${base}/${source.path}`, source.capture_sha256);
  assert.deepEqual(captured.inputs.case, item);
  const inputs = [],
    cache = new Map();
  for (const frame of item.frames) {
    const selected = await suppliedFrameRecord(reader, item, frame, base, manifest);
    const { meta } = selected;
    await validateFrameArtifacts(
      async (path) => (await reader.bytes(`${selected.base}/${item.id}/${path}`)).bytes,
      meta,
      item,
      selected.manifest.source,
      cache,
    );
    const path = `${selected.base}/${item.id}/${frame}/replay.fpln`;
    inputs.push({
      frame,
      plan: { path, sha256: (await reader.bytes(path)).sha256 },
      resources: `${selected.base}/${item.id}/frame-resources`,
      adapter: meta.adapter.gpuMemory.device,
    });
  }
  return {
    case: item,
    capture: { path: `${base}/${source.path}`, sha256: source.capture_sha256 },
    inputs,
  };
}

export async function captureNv12Case(context, assignment, binary, execute = runStep) {
  const { root, output } = context,
    { case: item, inputs } = assignment;
  await mkdir(output, { recursive: true });
  const local = (path) =>
    relative(toNamespacedPath(root), toNamespacedPath(path)).replaceAll("\\", "/");
  const pin = async (path) => ({ path: local(path), sha256: await hashFile(path) });
  const report = { status: "measured", assignment, steps: [], frames: [] };
  const ffmpeg = join(root, "build/ffmpeg/ffmpeg.exe");
  report.binary = await pin(binary);
  report.ffmpeg = await pin(ffmpeg);
  for (let start = 0; start < inputs.length; start += 32) {
    const batch = inputs.slice(start, start + 32);
    const jobs = batch.map((input) => ({
      plan: resolve(root, input.plan.path),
      resources: resolve(root, input.resources),
      out: join(output, String(input.frame), "render.png"),
      nv12_out: join(output, String(input.frame), "native.nv12"),
    }));
    const path = join(output, `batch-${start}.json`);
    await writeAtomicJson(path, jobs);
    const step = await execute(
      {
        id: `render-${start}`,
        file: binary,
        args: [
          "render-plan",
          "--batch",
          path,
          "--max-batch-frames",
          "32",
          "--dxcompiler",
          join(root, "node_modules/electron/dist/dxcompiler.dll"),
          "--resource-byte-budget",
          "536870912",
          "--gpu-budget-bytes",
          "1073741824",
        ],
        timeout_ms: 300000,
      },
      context,
    );
    report.steps.push(step);
    assert.equal(step.status, "passed", `NV12 batch ${item.id}/${start} failed`);
    const receipts = (await readFile(resolve(root, step.log), "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"schema_version":'))
      .map((line) => JSON.parse(line));
    assert.equal(receipts.length, batch.length);
    for (const [index, input] of batch.entries()) {
      const job = jobs[index],
        directory = join(output, String(input.frame));
      const frame = {
        frame: input.frame,
        receipt: receipts[index],
        batch_index: index,
        render_log: await pin(resolve(root, step.log)),
        png: await pin(job.out),
        nv12: await pin(job.nv12_out),
      };
      report.frames.push(frame);
      const reference = join(directory, "reference.nv12");
      const converted = await execute(
        {
          id: `convert-${input.frame}`,
          file: ffmpeg,
          args: [
            "-v",
            "error",
            "-i",
            job.out,
            "-frames:v",
            "1",
            "-vf",
            "scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=nv12",
            "-f",
            "rawvideo",
            reference,
          ],
        },
        context,
      );
      report.steps.push(converted);
      assert.equal(converted.status, "passed");
      frame.reference = await pin(reference);
      frame.planes = nv12PlaneComparison(
        await readFile(reference),
        await readFile(job.nv12_out),
        item.size,
      );
      for (const [arm, path] of [
        ["reference", reference],
        ["native", job.nv12_out],
      ]) {
        const decoded = await execute(
          {
            id: `decode-${input.frame}-${arm}`,
            file: ffmpeg,
            args: [
              "-v",
              "error",
              "-f",
              "rawvideo",
              "-pixel_format",
              "nv12",
              "-video_size",
              `${item.size.width}x${item.size.height}`,
              "-i",
              path,
              "-frames:v",
              "1",
              "-vf",
              "scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=bicubic+accurate_rnd+full_chroma_int,format=rgba",
              join(directory, `${arm}.png`),
            ],
          },
          context,
        );
        report.steps.push(decoded);
        assert.equal(decoded.status, "passed");
      }
      const contextPath = join(directory, "context.json");
      await writeAtomicJson(contextPath, {
        case_id: `nv12-conversion-${item.id}`,
        isolated: false,
        background: null,
        sequence: null,
      });
      const compared = await execute(
        {
          id: `compare-${input.frame}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            join(directory, "reference.png"),
            "--candidate",
            join(directory, "native.png"),
            "--tolerance",
            "yuv",
            "--context",
            contextPath,
            "--out",
            join(directory, "compare"),
          ],
        },
        context,
      );
      report.steps.push(compared);
      frame.comparison = await pin(join(directory, "compare/report.json"));
      const result = JSON.parse(await readFile(resolve(root, frame.comparison.path), "utf8"));
      assert.equal(compared.exit_code, result.comparison.passed ? 0 : 1);
    }
  }
  assert.equal(await hashFile(binary), report.binary.sha256);
  assert.equal(await hashFile(ffmpeg), report.ffmpeg.sha256);
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}

/** Recovery recomputes numeric verdicts and authenticates agent review before granting conversion coverage. */
export async function auditNv12Case(root, report, assignment, ledger) {
  assert.equal(report.status, "measured");
  assert.deepEqual(report.assignment, assignment);
  assert.deepEqual(
    report.frames.map((f) => f.frame),
    assignment.case.frames,
  );
  const reader = new M0Evidence(root),
    frames = [];
  const local = (path) =>
    relative(toNamespacedPath(root), toNamespacedPath(path)).replaceAll("\\", "/");
  for (const binary of [report.binary, report.ffmpeg])
    await reader.bytes(binary.path, binary.sha256);
  for (const [index, frame] of report.frames.entries()) {
    const input = assignment.inputs[index],
      receipt = frame.receipt,
      { width, height } = assignment.case.size;
    const log = (await reader.bytes(frame.render_log.path, frame.render_log.sha256)).bytes.toString(
      "utf8",
    );
    const receipts = log
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"schema_version":'))
      .map((line) => JSON.parse(line));
    assert.deepEqual(receipt, receipts[frame.batch_index]);
    assert.equal(receipt.frame_index, index % 32);
    assert.equal(frame.batch_index, index % 32);
    assert.equal(receipt.renderer_reused, index % 32 > 0);
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.native_gpu_execution, true);
    assert.equal(receipt.diagnostic_readback, true);
    assert.equal(receipt.width, width);
    assert.equal(receipt.height, height);
    assert.equal(receipt.adapter.name, input.adapter.name);
    assert.equal(receipt.adapter.vendor, input.adapter.vendorId);
    assert.equal(receipt.adapter.device, input.adapter.deviceId);
    assert(["Dx12", "Vulkan", "Metal"].includes(receipt.adapter.backend));
    assert.notEqual(receipt.adapter.device_type, "Cpu");
    assert.equal(receipt.plan_sha256, input.plan.sha256);
    await reader.bytes(input.plan.path, input.plan.sha256);
    const rgba = await reader.image(frame.png.path, frame.png.sha256);
    assert.equal(receipt.rgba_sha256, rgba.rgba_sha256);
    assert.equal(local(receipt.output), frame.png.path);
    assert.equal(receipt.nv12.format, "nv12-bt709-limited");
    assert.equal(local(receipt.nv12.path), frame.nv12.path);
    assert.equal(receipt.nv12.sha256, frame.nv12.sha256);
    assert.equal(receipt.nv12.bytes, (width * height * 3) / 2);
    const candidate = await reader.bytes(frame.nv12.path, frame.nv12.sha256),
      reference = await reader.bytes(frame.reference.path, frame.reference.sha256);
    const planes = nv12PlaneComparison(reference.bytes, candidate.bytes, assignment.case.size);
    assert.deepEqual(frame.planes, planes);
    const raw = await reader.json(frame.comparison.path, frame.comparison.sha256),
      c = raw.comparison;
    assert.equal(raw.context.case_id, `nv12-conversion-${assignment.case.id}`);
    assert.equal(c.profile.name, "yuv");
    assert.equal(c.width, width);
    assert.equal(c.height, height);
    assert.equal(
      c.passed,
      c.checks.every((check) => check.passed),
    );
    for (const side of ["reference", "candidate"]) {
      const image = await reader.image(local(raw[side].path), raw[side].png_sha256);
      assert.equal(image.rgba_sha256, c[`${side}_rgba_sha256`]);
    }
    const review = await reviewStatus(
      { context: { root }, ledger, bytes: (path) => reader.bytes(local(path)) },
      { case_id: raw.context.case_id, frame: frame.frame, profile: "yuv" },
      raw,
    );
    frames.push({
      frame: frame.frame,
      numeric_passed: planes.every((p) => p.passed) && c.passed,
      review,
      status: !planes.every((p) => p.passed) || !c.passed ? "failed" : review.status,
    });
  }
  await reader.stable();
  return {
    status: frames.some((f) => f.status === "failed")
      ? "failed"
      : frames.every((f) => f.status === "passed")
        ? "passed"
        : "incomplete",
    frames,
  };
}
