import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { sha256 } from "../migration/m0-evidence.mjs";
import { auditEffectShotFiles, runEffectShotSmoke } from "./effect-shots.mjs";
import { encodeRgbaPng } from "./png.mjs";

async function fixture(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "aster-effect-shots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const corpus = {
    cases: ["blur", "glow"].map((type) => ({ id: `effect-${type}`, features: [`effect:${type}`] })),
  };
  await write(".gitignore", "artifacts/\n");
  await write("tests/parity/corpus.json", corpus);
  await write("shaders/manifest.json", { schema_version: 1, programs: {} });
  const hooks = join(root, "empty-hooks");
  await mkdir(hooks);
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Aster Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "🧪 Initialize effect-shot fixture",
    ],
  ])
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        `core.hooksPath=${hooks}`,
        ...args,
      ],
      { cwd: root, windowsHide: true },
    );
  const manifest = {
    schema_version: 1,
    kind: "effect-shot-ops",
    width: 640,
    height: 360,
    time: 0.5,
    parameter_source: "registry-defaults",
    registry_types: ["blur", "glow"],
    corpus_sha256: sha256(await readFile(join(root, "tests/parity/corpus.json"))),
    shader_manifest_sha256: sha256(await readFile(join(root, "shaders/manifest.json"))),
    shader_programs: ["post-process", "blur-downsample", "brightpass-downsample"].map((id) => ({
      id,
      sha256: "a".repeat(64),
    })),
    effects: ["blur", "glow"].map((type) => ({
      type,
      name: type,
      case_id: `effect-${type}`,
      ops: [Array(16).fill(1)],
    })),
  };
  let nativeCalls = 0;
  const execute = async (command) => {
    const result = {
      id: command.id,
      status: "passed",
      exit_code: 0,
      command: [command.file, ...command.args],
    };
    if (command.id === "effect-shot-ops") {
      await change("manifest", manifest);
      const directory = command.env.ASTER_EFFECT_SHOT_OUTPUT;
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "effects.json"), JSON.stringify(manifest));
      await change("dump", directory);
    } else {
      nativeCalls++;
      const output = command.args.at(-1);
      const harness = command.args.at(-3);
      await mkdir(output, { recursive: true });
      const native = {
        schema_version: 1,
        status: "passed",
        adapter: {
          name: "Test GPU",
          vendor: 1,
          device: 2,
          device_type: "DiscreteGpu",
          driver: "test",
          driver_info: "test",
          backend: "Vulkan",
        },
        effects_manifest_sha256: sha256(await readFile(join(harness, "effects.json"))),
        shader_sources: manifest.shader_programs,
        images: [],
      };
      for (const [index, entry] of manifest.effects.entries()) {
        const file = `${String(index + 1).padStart(3, "0")}-${entry.type}.png`;
        const bytes = encodeRgbaPng(640, 360, Buffer.alloc(640 * 360 * 4, index + 1));
        await writeFile(join(output, file), bytes);
        native.images.push({
          type: entry.type,
          file,
          width: 640,
          height: 360,
          png_sha256: sha256(bytes),
        });
      }
      await change("native", native, output);
      await writeFile(join(output, "report.json"), JSON.stringify(native));
      await change("files", output, root);
    }
    await change("step", result);
    return result;
  };
  return {
    root,
    manifest,
    execute,
    calls: () => nativeCalls,
    run: () => runEffectShotSmoke({ root, env: process.env }, execute),
  };
}

test("fresh effect inputs publish all verified PNGs and can be independently re-audited", async (t) => {
  const fixtureData = await fixture(t);
  const first = await fixtureData.run();
  assert.equal(first.status, "passed", first.error);
  const report = JSON.parse(await readFile(join(fixtureData.root, first.report_path)));
  const audited = await auditEffectShotFiles(fixtureData.root, report);
  assert.equal(audited.effects, 2);
  assert.equal(report.outputs.length, 2);
  assert.equal(
    sha256(await readFile(join(fixtureData.root, first.report_path))),
    first.report_sha256,
  );
  const second = await fixtureData.run();
  assert.equal(second.status, "passed", second.error);
  assert.notEqual(second.report_path, first.report_path);
  assert.equal(fixtureData.calls(), 2);
  await writeFile(join(fixtureData.root, report.outputs[0].path), Buffer.from("corrupted"));
  await assert.rejects(() => auditEffectShotFiles(fixtureData.root, report), /SHA-256 differs/);
});

test("missing effects are rejected against corpus coverage before native execution", async (t) => {
  const fixtureData = await fixture(t, (phase, value) => {
    if (phase === "manifest") {
      value.effects.pop();
      value.registry_types.pop();
    }
  });
  const result = await fixtureData.run();
  assert.equal(result.status, "failed");
  assert.match(result.error, /coverage differs from corpus/);
  assert.equal(fixtureData.calls(), 0);
});

for (const [name, modify, expected] of [
  [
    "stale native manifest",
    (native) => {
      native.effects_manifest_sha256 = "b".repeat(64);
    },
    /input is stale/,
  ],
  [
    "different native shader",
    (native) => {
      native.shader_sources = structuredClone(native.shader_sources);
      native.shader_sources[0].sha256 = "b".repeat(64);
    },
    /shader sources differ/,
  ],
  [
    "missing PNG",
    async (_native, output) => {
      await rm(join(output, "001-blur.png"));
    },
    /ENOENT/,
  ],
  [
    "extra PNG",
    async (_native, output) => {
      await writeFile(join(output, "stale.png"), "stale");
    },
    /extra native output/,
  ],
  [
    "self-consistent truncated PNG",
    async (native, output) => {
      const bytes = Buffer.from("not PNG");
      await writeFile(join(output, "001-blur.png"), bytes);
      native.images[0].png_sha256 = sha256(bytes);
    },
    /PNG/,
  ],
  [
    "self-consistent wrong PNG dimensions",
    async (native, output) => {
      const bytes = encodeRgbaPng(1, 1, Buffer.alloc(4));
      await writeFile(join(output, "001-blur.png"), bytes);
      native.images[0].png_sha256 = sha256(bytes);
    },
    /PNG width/,
  ],
])
  test(`rejects ${name} without publishing partial output`, async (t) => {
    const fixtureData = await fixture(t, async (phase, value, directory) => {
      if (phase === "native") await modify(value, directory);
    });
    const result = await fixtureData.run();
    assert.equal(result.status, "failed");
    assert.match(result.error, expected);
    await assert.rejects(
      readFile(join(fixtureData.root, dirname(result.report_path), "native", "report.json")),
      /ENOENT/,
    );
    await assert.rejects(
      readFile(join(fixtureData.root, dirname(result.report_path), "pending", "report.json")),
      /ENOENT/,
    );
  });

test("a failing native process and source changes cannot produce a passing smoke", async (t) => {
  for (const mode of ["process", "source"]) {
    const fixtureData = await fixture(t, async (phase, value, root) => {
      if (mode === "process" && phase === "step" && value.id === "effect-shot-native") {
        value.status = "failed";
        value.exit_code = 1;
      }
      if (mode === "source" && phase === "files")
        await writeFile(join(root, "source-changed.txt"), "changed");
    });
    const result = await fixtureData.run();
    assert.equal(result.status, "failed");
    assert.match(result.error, mode === "process" ? /rendering failed/ : /source changed/);
  }
});
