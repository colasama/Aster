import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import {
  coreAdditionalGeometryCases,
  coreCases,
  coreLayerCases,
  coreSurfaceCases,
} from "./native-core-scope.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Require byte-identical first, repeated and disabled cache output on every executable whole frame. */
export async function runNativeLayerCacheGate(
  context,
  { binary, compiler, frames, surfaceFrames },
  execute = runStep,
) {
  const report = { status: "failed", frames: [], batches: [], exact: 0, hits: 0 };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const inputs = frames.map((frame) => ({
      id: `${frame.case_id}-${frame.frame}`,
      plan: join(context.root, frame.input.path),
      resources: join(context.root, dirname(dirname(frame.input.path)), "frame-resources"),
      expected: frame.receipt,
      dxc:
        !coreCases.includes(frame.case_id) ||
        coreLayerCases.includes(frame.case_id) ||
        coreSurfaceCases.includes(frame.case_id) ||
        coreAdditionalGeometryCases.includes(frame.case_id),
    }));
    for (const frame of surfaceFrames) {
      const id = frame.case_id.replace("native-surface-frame-", "");
      inputs.push({
        id: frame.case_id,
        plan: join(context.root, "tests/parity/native-surface-frame", id, "plan.fpln"),
        resources: join(context.root, "tests/parity/native-surface-frame/resources"),
        expected: frame.receipt,
        dxc: true,
      });
    }
    assert.equal(inputs.length, 1248);
    report.required_count = inputs.length;
    for (const dxc of [false, true]) {
      const selected = inputs.filter((input) => input.dxc === dxc);
      for (const enabled of [false, true]) {
        const label = `${dxc ? "dxc" : "default"}-${enabled ? "cached" : "uncached"}`;
        const jobs = selected.flatMap((input) =>
          (enabled ? ["first", "repeated"] : ["disabled"]).map((phase) => ({
            plan: input.plan,
            resources: input.resources,
            out: join(context.output, label, `${input.id}-${phase}.png`),
          })),
        );
        const batch = join(context.output, `${label}.json`);
        await writeAtomicJson(batch, jobs);
        const step = await execute(
          {
            id: `layer-cache-${label}`,
            file: binary,
            args: [
              "render-plan",
              "--batch",
              batch,
              "--layer-cache-bytes",
              enabled ? "67108864" : "0",
              ...(dxc && compiler ? ["--dxcompiler", compiler] : []),
            ],
            timeout_ms: 600_000,
          },
          context,
        );
        report.batches.push(step);
        assert.equal(step.status, "passed");
        const receipts = (await readFile(join(context.root, step.log), "utf8"))
          .split(/\r?\n/)
          .filter((line) => line.startsWith('{"schema_version":'))
          .map((line) => JSON.parse(line));
        assert.equal(receipts.length, jobs.length);
        for (const [index, receipt] of receipts.entries()) {
          const input = selected[Math.floor(index / (enabled ? 2 : 1))];
          const pixels = await reader.image(local(jobs[index].out));
          assert.equal(receipt.status, "passed");
          assert.equal(receipt.frame_index, index);
          assert.equal(receipt.renderer_reused, index > 0);
          assert.equal(receipt.plan_sha256, input.expected.plan_sha256);
          assert.deepEqual(receipt.adapter, input.expected.adapter);
          assert.equal(receipt.width, input.expected.width);
          assert.equal(receipt.height, input.expected.height);
          assert.equal(pixels.rgba_sha256, receipt.rgba_sha256);
          assert.equal(
            receipt.rgba_sha256,
            input.expected.rgba_sha256,
            `Cache changed pixels: ${input.id}/${label}/${index}`,
          );
          assert(receipt.layer_cache.resident_bytes <= 67108864);
          if (!enabled) {
            assert.equal(receipt.layer_cache.allocations, 0);
            assert.equal(receipt.layer_cache.hits, 0);
            assert.equal(receipt.layer_cache.resident_bytes, 0);
          }
          if (enabled && index % 2 && receipt.layer_cache.resident_bytes > 0) {
            assert(
              receipt.layer_cache.hits > receipts[index - 1].layer_cache.hits,
              `Repeated frame did not reuse its admitted layer: ${input.id}`,
            );
            assert.equal(
              receipt.layer_cache.allocations,
              receipts[index - 1].layer_cache.allocations,
            );
          }
          report.frames.push({
            id: input.id,
            path: local(jobs[index].out),
            rgba_sha256: pixels.rgba_sha256,
            png_sha256: pixels.png_sha256,
            mode: label,
            phase: enabled ? (index % 2 ? "repeated" : "first") : "disabled",
            cache: receipt.layer_cache,
          });
          report.exact += 1;
        }
        if (enabled) report.hits += receipts.at(-1).layer_cache.hits;
      }
    }
    assert.equal(report.exact, inputs.length * 3);
    assert(report.hits > 0, "No retained post-effect output was reused");
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
