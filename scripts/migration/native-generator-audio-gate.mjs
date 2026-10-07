import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { generatorAudioFixtures } from "./native-generator-audio-fixtures.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

export async function runNativeGeneratorAudioGate(
  context,
  { binary, compiler, base, frames },
  execute = runStep,
) {
  const report = { status: "failed", controls: [], rejections: [], exact_replays: 0 };
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const resources = join(context.output, "resources");
    await mkdir(resources);
    const fixtures = await generatorAudioFixtures(context.root, base);
    const jobs = [],
      inputs = [];
    for (const fixture of fixtures) {
      const expected = frames.find((f) => f.case_id === fixture.case_id && f.frame === 6);
      assert.deepEqual(fixture.source, expected?.input);
      const directory = join(context.output, fixture.id);
      await mkdir(directory);
      const plan = join(directory, "plan.fpln");
      await writeFile(plan, fixture.plan, { flag: "wx" });
      await writeAtomicJson(
        join(directory, "resources.json"),
        fixture.resources.map((r) => r.message),
      );
      for (const resource of fixture.resources)
        await writeFile(join(resources, `${resource.message.hash}.bin`), resource.bytes);
      const out = join(context.output, `${fixture.id}.png`);
      inputs.push({ id: fixture.id, mode: fixture.mode, expected, plan, out });
      if (fixture.mode !== "conflict") jobs.push({ plan, resources, out });
    }
    for (const input of inputs.filter((f) => f.mode === "silent")) {
      jobs.push({
        plan: join(context.root, input.expected.input.path),
        resources: join(context.root, base, input.expected.case_id, "frame-resources"),
        out: join(context.output, `${input.id}-restored.png`),
      });
    }
    const request = join(context.output, "batch.json");
    await writeAtomicJson(request, jobs);
    const args = compiler ? ["--dxcompiler", compiler] : [];
    report.step = await execute(
      {
        id: "native-generator-audio-controls",
        file: binary,
        args: ["render-plan", "--batch", request, ...args],
      },
      context,
    );
    assert.equal(report.step.status, "passed");
    const receipts = (await readFile(join(context.root, report.step.log), "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"schema_version":'))
      .map((line) => JSON.parse(line));
    assert.equal(receipts.length, jobs.length);
    const images = new Map();
    for (const [index, job] of jobs.entries()) {
      const pixels = await reader.image(local(job.out));
      assert.equal(receipts[index].rgba_sha256, pixels.rgba_sha256);
      assert.equal(receipts[index].plan_sha256, await hashFile(job.plan));
      assert.equal(receipts[index].native_gpu_execution, true);
      images.set(job.out, pixels);
    }
    for (const kind of ["bars", "ring", "scope"]) {
      const silent = inputs.find((f) => f.id === `${kind}-silent`);
      const reference = await reader.image(
        silent.expected.output.path,
        silent.expected.output.sha256,
      );
      const silentChanged = images
        .get(silent.out)
        .pixels.reduce((n, value, i) => n + Number(value !== reference.pixels[i]), 0);
      assert(silentChanged > 16, "Silent audio must visibly change output");
      assert.notEqual(
        images.get(silent.out).rgba_sha256,
        reference.rgba_sha256,
        "Silent audio must change pixels",
      );
      const shared = images.get(inputs.find((f) => f.id === `${kind}-shared`).out);
      const inherited = images.get(inputs.find((f) => f.id === `${kind}-inherited`).out);
      const siblingChanged = shared.pixels.reduce(
        (n, value, i) => n + Number(value !== reference.pixels[i]),
        0,
      );
      assert(siblingChanged > 16, "Sibling must visibly contribute");
      assert.equal(shared.rgba_sha256, inherited.rgba_sha256, "Sibling must inherit frame audio");
      assert.notEqual(
        shared.rgba_sha256,
        reference.rgba_sha256,
        "Additional sibling must be visible",
      );
      const restored = images.get(join(context.output, `${kind}-silent-restored.png`));
      assert.equal(restored.rgba_sha256, reference.rgba_sha256, "Audio must reset across frames");
      report.exact_replays += 2;
      report.controls.push({
        kind,
        silent_changed_bytes: silentChanged,
        sibling_changed_bytes: siblingChanged,
        silent_changed: true,
        sibling_visible: true,
        shared_exact: true,
        restored_exact: true,
      });
      const conflict = inputs.find((f) => f.id === `${kind}-conflict`);
      const step = await execute(
        {
          id: `reject-generator-audio-${kind}`,
          file: binary,
          args: [
            "render-plan",
            "--plan",
            conflict.plan,
            "--resources",
            resources,
            "--out",
            conflict.out,
            ...args,
          ],
        },
        context,
      );
      assert.equal(step.exit_code, 2);
      assert.match(
        await readFile(join(context.root, step.log), "utf8"),
        /generator audio differs within frame/,
      );
      await assert.rejects(stat(conflict.out), { code: "ENOENT" });
      report.rejections.push({ kind, step, output_absent: true });
    }
    report.receipts = receipts;
    report.batch = { path: local(request), sha256: await hashFile(request) };
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
