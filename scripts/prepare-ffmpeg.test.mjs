import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ffmpegBinaryName, prepareFfmpegBundle, resolveFfmpegSource } from "./prepare-ffmpeg.mjs";

const temporaryRoots = [];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "aster-ffmpeg-bundle-"));
  temporaryRoots.push(root);
  return root;
}

test("resolves an explicit FFmpeg path before PATH", () => {
  const root = temporaryRoot();
  const explicit = join(root, ffmpegBinaryName());
  writeFileSync(explicit, "explicit");
  assert.equal(
    resolveFfmpegSource({ environment: { ASTER_FFMPEG_PATH: explicit, PATH: "" } }),
    explicit,
  );
});

test("finds the current platform executable on PATH", () => {
  const root = temporaryRoot();
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  const executable = join(second, ffmpegBinaryName());
  writeFileSync(executable, "path");
  assert.equal(
    resolveFfmpegSource({ environment: { PATH: `${first}${delimiter}${second}` } }),
    executable,
  );
});

test("copies the validated executable and records provenance in the controlled build folder", () => {
  const root = temporaryRoot();
  const source = join(root, `source-${ffmpegBinaryName()}`);
  const projectRoot = join(root, "project");
  writeFileSync(source, "ffmpeg-binary");
  const prepared = prepareFfmpegBundle({
    environment: { ASTER_FFMPEG_PATH: source, PATH: "" },
    projectRoot,
    probe: () => ({ error: undefined, status: 0, stderr: "", stdout: "ffmpeg version test\n" }),
  });
  assert.equal(readFileSync(prepared.destination, "utf8"), "ffmpeg-binary");
  assert.deepEqual(
    JSON.parse(readFileSync(join(projectRoot, "build", "ffmpeg", "ffmpeg-source.json"), "utf8")),
    { source, version: "ffmpeg version test" },
  );
});

test("fails with an actionable message when FFmpeg is unavailable", () => {
  assert.throws(
    () => resolveFfmpegSource({ environment: { PATH: "" } }),
    /Install FFmpeg or set ASTER_FFMPEG_PATH/,
  );
});

test("desktop launch and artifact scripts compile and stage their runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  assert.match(manifest.scripts.dev, /electron:compile.*concurrently/);
  assert.equal(manifest.scripts.electron, "pnpm dev");
  assert.match(
    manifest.scripts["artifact:build"],
    /^pnpm artifact:prepare-ffmpeg && pnpm build && electron-builder$/,
  );
  assert.deepEqual(
    manifest.build.extraResources.find((entry) => entry.from === "build/ffmpeg"),
    {
      from: "build/ffmpeg",
      to: "bin",
      filter: ["ffmpeg", "ffmpeg.exe"],
    },
  );
});
