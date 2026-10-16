import assert from "node:assert/strict";
import { copyFile, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runStep } from "./process.mjs";
import { hashFile } from "./source.mjs";

export const EXPORT_VMAF_MODEL = "vmaf_v0.6.1neg";

export function exportQualityMethod(filters) {
  const names = new Set(
    [...filters.matchAll(/^\s*[TSC.]{3}\s+(\w+)\s+/gm)].map((match) => match[1]),
  );
  if (names.has("libvmaf")) return "vmaf";
  assert(names.has("ssim") && names.has("psnr"), "FFmpeg lacks required quality filters");
  return "ssim-psnr";
}

/** Positive infinity is lossless PSNR, not absent evidence; JSON preserves it as a string. */
export function exportQualityPassed(quality) {
  if ((quality.method ?? "vmaf") === "vmaf") {
    assert(Number.isFinite(quality.vmaf.native) && Number.isFinite(quality.vmaf.ts));
    return quality.vmaf.native >= quality.vmaf.ts - 1;
  }
  assert.equal(quality.method, "ssim-psnr");
  const values = {};
  for (const arm of ["native", "ts"]) {
    assert(Number.isFinite(quality.ssim[arm]));
    assert(quality.ssim[arm] >= -1 && quality.ssim[arm] <= 1);
    const psnr = quality.psnr[arm];
    assert(psnr === "inf" || (Number.isFinite(psnr) && psnr >= 0));
    values[arm] = psnr === "inf" ? Infinity : psnr;
  }
  return quality.ssim.native >= quality.ssim.ts - 0.002 && values.native >= values.ts - 0.5;
}

/** Reject missing, repeated or non-finite frames before computing pooled filter scores. */
export function parseExportQuality(metric, text, count, commandLog = "") {
  assert(Number.isSafeInteger(count) && count > 0);
  if (metric === "vmaf") {
    const result = JSON.parse(text);
    assert.equal(result.frames.length, count);
    assert(result.frames.every((f, i) => f.frameNum === i && Number.isFinite(f.metrics.vmaf)));
    const mean = result.pooled_metrics.vmaf.mean;
    assert(Number.isFinite(mean));
    assert(
      Math.abs(mean - result.frames.reduce((sum, f) => sum + f.metrics.vmaf, 0) / count) <=
        0.000002,
    );
    return mean;
  }
  assert(["ssim", "psnr"].includes(metric));
  const rows = text.trim().split(/\r?\n/);
  assert.equal(rows.length, count, "Incomplete quality frame statistics");
  const values = rows.map((line, i) => {
    const fields = Object.fromEntries(
      [...line.matchAll(/(\w+):([^\s]+)/g)].map((m) => [m[1], m[2]]),
    );
    assert.equal(Number(fields.n), i + 1, "Quality frame identity differs");
    const value = Number(fields[metric === "ssim" ? "All" : "mse_avg"]);
    assert(Number.isFinite(value));
    if (metric === "ssim") assert(value >= -1 && value <= 1);
    else assert(value >= 0 && value <= 65025);
    return { value, lossless: fields.psnr_avg === "inf" };
  });
  const mean = values.reduce((sum, row) => sum + row.value, 0) / count;
  if (metric === "ssim") return mean;
  // FFmpeg pools MSE before converting to dB. Per-frame MSE is rounded to two decimal places.
  const summaries = [...commandLog.matchAll(/PSNR y:\S+ u:\S+ v:\S+ average:(\S+) min:/g)];
  assert.equal(summaries.length, 1, "Missing or duplicate PSNR aggregate");
  const summary = summaries[0][1];
  if (summary === "inf") {
    assert(values.every((row) => row.lossless && row.value === 0));
    return "inf";
  }
  const db = Number(summary);
  assert(Number.isFinite(db) && db >= 0);
  const pooledMse = 65025 * 10 ** (-db / 10);
  assert(
    Math.abs(pooledMse - mean) <= 0.005001 + pooledMse * 0.00000012,
    "PSNR aggregate differs from frame MSE",
  );
  return db;
}

/** Shared by corpus and diagnostic clips; a failed VMAF run must never trigger fallback. */
export async function scoreExportSamples(context, samples, exports, execute = runStep) {
  const { root, output } = context;
  assert(samples.length > 0);
  assert(
    samples.every(
      ({ frame }, i) =>
        Number.isSafeInteger(frame) && frame >= 0 && (i === 0 || frame > samples[i - 1].frame),
    ),
  );
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const pin = async (path) => ({ path: local(path), sha256: await hashFile(path) });
  const ffmpeg = join(root, "build/ffmpeg/ffmpeg.exe");
  const binary = await pin(ffmpeg);
  const probe = await execute(
    { id: "quality-filters", file: ffmpeg, args: ["-hide_banner", "-filters"] },
    context,
  );
  assert.equal(probe.status, "passed");
  const filterPath = resolve(root, probe.log);
  const method = exportQualityMethod(await readFile(filterPath, "utf8"));
  const quality = {
    method,
    ...(method === "vmaf" ? { model: EXPORT_VMAF_MODEL } : {}),
    evidence: [],
    capability: { binary, filters: await pin(filterPath) },
    steps: [probe],
  };
  const metrics = method === "vmaf" ? ["vmaf"] : ["ssim", "psnr"];
  for (const metric of metrics) quality[metric] = {};
  for (const [index, sample] of samples.entries())
    await copyFile(sample.path, join(output, `score-reference-${index}.png`));
  const select = samples.map(({ frame }) => `eq(n\\,${frame})`).join("+");
  for (const arm of ["native", "ts"]) {
    const video = exports[arm];
    assert.equal(await hashFile(video.path), video.sha256);
    for (const metric of metrics) {
      const filename = `${arm}-${metric}.${metric === "vmaf" ? "json" : "txt"}`;
      const filter =
        metric === "vmaf"
          ? `libvmaf=model=version=${EXPORT_VMAF_MODEL}:log_fmt=json:log_path=${filename}`
          : `${metric}=stats_file=${filename}`;
      const step = await execute(
        {
          id: `${arm}-${metric}`,
          file: ffmpeg,
          args: [
            "-hide_banner",
            "-v",
            "info",
            "-i",
            video.path,
            "-framerate",
            "25",
            "-i",
            "score-reference-%d.png",
            "-lavfi",
            `[0:v]select=${select},format=yuv420p,settb=1/25,setpts=N[dist];[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,settb=1/25,setpts=N[ref];[dist][ref]${filter}:shortest=1:repeatlast=0`,
            "-frames:v",
            String(samples.length),
            "-f",
            "null",
            "-",
          ],
        },
        { ...context, root: output },
      );
      quality.steps.push(step);
      assert.equal(step.status, "passed", `${arm} ${metric} scoring failed`);
      const stats = join(output, filename),
        log = resolve(output, step.log);
      quality[metric][arm] = parseExportQuality(
        metric,
        await readFile(stats, "utf8"),
        samples.length,
        await readFile(log, "utf8"),
      );
      quality.evidence.push({ ...(await pin(stats)), arm, metric, command_log: await pin(log) });
    }
    assert.equal(await hashFile(video.path), video.sha256);
  }
  assert.equal(await hashFile(ffmpeg), binary.sha256);
  return {
    ...quality,
    passed: exportQualityPassed(quality),
    scope:
      "Declared frame indices decoded directly from both MP4 YUV streams; frozen RGB references converted once to BT.709 limited YUV420P, without an extra candidate RGB round trip",
  };
}

export async function auditExportQuality(reader, quality, count) {
  const method = quality.method ?? "vmaf";
  if (method === "vmaf")
    assert.equal(quality.model, EXPORT_VMAF_MODEL, "Missing or changed VMAF model");
  if (quality.method) {
    const { binary, filters } = quality.capability;
    await reader.bytes(binary.path, binary.sha256);
    const log = await reader.bytes(filters.path, filters.sha256);
    assert.equal(exportQualityMethod(log.bytes.toString("utf8")), method);
  }
  const metrics = method === "vmaf" ? ["vmaf"] : ["ssim", "psnr"];
  assert.equal(quality.evidence.length, metrics.length * 2);
  assert.equal(new Set(quality.evidence.map((e) => e.path)).size, quality.evidence.length);
  for (const [index, arm] of ["native", "ts"].entries()) {
    for (const metric of metrics) {
      const pin = quality.method
        ? quality.evidence.find((e) => e.arm === arm && e.metric === metric)
        : quality.evidence[index];
      assert(pin, "Missing quality arm or metric evidence");
      const stats = await reader.bytes(pin.path, pin.sha256);
      const log = pin.command_log
        ? await reader.bytes(pin.command_log.path, pin.command_log.sha256)
        : null;
      if (metric === "vmaf") {
        assert(log, "Missing authenticated VMAF command log");
        const firstLine = log.bytes.toString("utf8").split(/\r?\n/, 1)[0];
        assert(firstLine.startsWith("Command: "), "Missing VMAF command identity");
        const command = JSON.parse(firstLine.slice("Command: ".length));
        assert(Array.isArray(command) && command.every((arg) => typeof arg === "string"));
        assert.equal(
          resolve(command[0]),
          resolve(reader.root, quality.capability.binary.path),
          "VMAF command did not use the authenticated FFmpeg binary",
        );
        const filters = command.filter((_arg, i) => command[i - 1] === "-lavfi");
        assert.equal(filters.length, 1, "Missing or duplicate VMAF filter");
        const suffix = `[dist][ref]libvmaf=model=version=${EXPORT_VMAF_MODEL}:log_fmt=json:log_path=${arm}-vmaf.json:shortest=1:repeatlast=0`;
        assert(filters[0].endsWith(suffix), "Quality arm used a different VMAF model or options");
        assert.equal(filters[0].split("libvmaf").length, 2, "Multiple VMAF models are forbidden");
        const step = quality.steps.find((item) => item.id === `${arm}-vmaf`);
        assert(step && step.status === "passed", "Missing successful VMAF execution");
        assert.deepEqual(
          step.command,
          command,
          "VMAF execution differs from its authenticated log",
        );
      }
      assert.equal(
        quality[metric][arm],
        parseExportQuality(
          metric,
          stats.bytes.toString("utf8"),
          count,
          log?.bytes.toString("utf8"),
        ),
      );
    }
  }
  assert.equal(quality.passed, exportQualityPassed(quality));
}
