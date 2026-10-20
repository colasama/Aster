import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { build } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Use the installed browser decoder as an independent reference for native acquisition. */
export async function captureBrowserAudioOracle(root, output, env = process.env) {
  const directory = join(dirname(output), "browser-audio");
  const sources = new Map();
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const remember = async (path) => {
    const hash = sha256(await readFile(path));
    if (sources.has(path)) assert.equal(sources.get(path), hash);
    sources.set(path, hash);
  };
  for (const path of [
    "scripts/migration/native-browser-audio-oracle.mjs",
    "scripts/migration/native-browser-audio-host.mjs",
    "build/ffmpeg/ffmpeg.exe",
    "build/ffmpeg/ffprobe.exe",
  ])
    await remember(join(root, path));
  await build({
    root,
    configFile: false,
    define: { "import.meta.env": "{}" },
    plugins: [
      {
        name: "audio-oracle-source-identity",
        async transform(_code, id) {
          const path = id.split("?")[0];
          if (isAbsolute(path) && !path.includes("\0")) await remember(path);
        },
      },
    ],
    build: {
      outDir: directory,
      emptyOutDir: false,
      lib: {
        entry: join(root, "scripts/migration/native-browser-audio-entry.mjs"),
        name: "AsterAudioOracle",
        formats: ["iife"],
        fileName: () => "entry.js",
      },
    },
  });
  const electron = createRequire(import.meta.url)("electron");
  await remember(electron);
  await remember(join(directory, "entry.js"));
  const config = join(directory, "config.json");
  await writeAtomicJson(config, {
    output: directory,
    projectRoot: resolve(env.ASTER_PERF_PROJECT || "D:/code/SD04PV"),
  });
  const childEnv = { ...env, ASTER_BROWSER_AUDIO_CONFIG: config };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const step = await runStep(
    {
      id: "browser-audio-capture",
      file: electron,
      args: [join(root, "scripts/migration/native-browser-audio-host.mjs")],
      timeout_ms: 240000,
    },
    { root, output: directory, env: childEnv },
  );
  assert.equal(step.status, "passed", `Browser audio capture failed: ${step.log}`);
  const oracle = JSON.parse(await readFile(join(directory, "oracle.json")));
  assert(
    oracle.cases.length > 0 && oracle.cases.every((item) => item.sources && item.samples.length),
  );
  for (const [path, hash] of sources) {
    assert.equal(sha256(await readFile(path)), hash, `Audio producer changed: ${path}`);
    oracle.sources.push({ path: local(path).startsWith("../") ? path : local(path), sha256: hash });
  }
  for (const proof of oracle.sources)
    assert.equal(sha256(await readFile(resolve(root, proof.path))), proof.sha256);
  await writeAtomicJson(output, oracle);
  return {
    cases: oracle.cases.length,
    samples: oracle.cases.reduce((n, item) => n + item.samples.length, 0),
    decode: "native-codec-and-resampler-versus-browser-offline-audio-context",
    browser: oracle.browser,
    capture: step,
  };
}
