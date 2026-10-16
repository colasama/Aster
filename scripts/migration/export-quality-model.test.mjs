import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { auditExportQuality, scoreExportSamples } from "./export-quality.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { hashFile } from "./source.mjs";

async function fixture(t, failModel = false) {
  const root = await mkdtemp(join(tmpdir(), "aster-quality-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "output");
  await mkdir(output);
  await mkdir(join(root, "build/ffmpeg"), { recursive: true });
  await writeFile(join(root, "build/ffmpeg/ffmpeg.exe"), "test binary identity");
  const exports = {};
  for (const arm of ["native", "ts"]) {
    const path = join(root, `${arm}.mp4`);
    await writeFile(path, arm);
    exports[arm] = { path, sha256: await hashFile(path) };
  }
  const path = join(root, "reference.png");
  await writeFile(path, "reference identity");
  const calls = [];
  const execute = async (command, context) => {
    calls.push(command.id);
    const log = join(output, `${command.id}.log`);
    const argv = [command.file, ...command.args];
    let text = `Command: ${JSON.stringify(argv)}\n`;
    if (command.id === "quality-filters") {
      text += " ... libvmaf VV->V\n TS. ssim VV->V\n TS. psnr VV->V\n";
    } else if (!failModel) {
      const value = command.id === "native-vmaf" ? 75 : 76;
      await writeFile(
        join(output, `${command.id}.json`),
        JSON.stringify({
          frames: [{ frameNum: 0, metrics: { vmaf: value } }],
          pooled_metrics: { vmaf: { mean: value } },
        }),
      );
    }
    await writeFile(log, text);
    return {
      id: command.id,
      command: argv,
      status: failModel && command.id !== "quality-filters" ? "failed" : "passed",
      log: relative(context.root, log).replaceAll("\\", "/"),
    };
  };
  return {
    root,
    context: { root, output },
    samples: [{ frame: 0, path }],
    exports,
    execute,
    calls,
  };
}

test("both encoding arms use the pinned model at the unchanged one-point threshold", async (t) => {
  const f = await fixture(t);
  const quality = await scoreExportSamples(f.context, f.samples, f.exports, f.execute);
  assert.equal(quality.model, "vmaf_v0.6.1neg");
  assert.equal(quality.passed, true);
  const reader = new M0Evidence(f.root);
  await auditExportQuality(reader, quality, 1);
  await reader.stable();
  for (const model of [undefined, null, "vmaf_v0.6.1", "vmaf_4k_v0.6.1"]) {
    await assert.rejects(
      auditExportQuality(new M0Evidence(f.root), { ...quality, model }, 1),
      /VMAF model/,
    );
  }
});

test("authenticated evidence rejects per-arm model changes and forged execution records", async (t) => {
  const f = await fixture(t);
  const quality = await scoreExportSamples(f.context, f.samples, f.exports, f.execute);
  for (const arm of ["native", "ts"]) {
    const originalPin = quality.evidence.find((e) => e.arm === arm).command_log;
    const log = await readFile(join(f.root, originalPin.path), "utf8");
    for (const mode of ["standard", "missing", "duplicate", "options", "execution", "binary"]) {
      const changed = structuredClone(quality);
      const command = JSON.parse(log.split("\n")[0].slice("Command: ".length));
      const i = command.indexOf("-lavfi") + 1;
      if (mode === "standard") command[i] = command[i].replace("vmaf_v0.6.1neg", "vmaf_v0.6.1");
      if (mode === "missing") command[i] = command[i].replace("model=version=vmaf_v0.6.1neg:", "");
      if (mode === "duplicate") command[i] = `libvmaf=model=version=vmaf_v0.6.1;${command[i]}`;
      if (mode === "options") command[i] = command[i].replace("repeatlast=0", "repeatlast=1");
      if (mode === "execution" || mode === "binary") command[0] = "different-ffmpeg.exe";
      const path = join(f.root, `${arm}-${mode}.log`);
      await writeFile(path, `Command: ${JSON.stringify(command)}\n`);
      changed.evidence.find((e) => e.arm === arm).command_log = {
        path: relative(f.root, path).replaceAll("\\", "/"),
        sha256: await hashFile(path),
      };
      if (mode !== "execution") changed.steps.find((s) => s.id === `${arm}-vmaf`).command = command;
      await assert.rejects(auditExportQuality(new M0Evidence(f.root), changed, 1));
    }
  }
});

test("unsupported model failure cannot silently switch metrics", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(
    scoreExportSamples(f.context, f.samples, f.exports, f.execute),
    /scoring failed/,
  );
  assert.deepEqual(f.calls, ["quality-filters", "native-vmaf"]);
});
