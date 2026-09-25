import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.on("uncaughtExceptionMonitor", (error) => {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const message = (error.stack ?? String(error))
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  process.stderr.write(`::error title=Desktop bundle verification failed::${message}\n`);
});

const bin = resolve(process.argv[2]);
const universal = process.argv.includes("--universal");
const checksumsOnly = process.argv.includes("--checksums-only");
const run = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", timeout: 60_000, windowsHide: true });
const executable = (name) => join(bin, process.platform === "win32" ? `${name}.exe` : name);
if (!checksumsOnly) {
  if (process.platform === "darwin")
    run("codesign", ["--verify", "--deep", "--strict", resolve(bin, "../../..")]);
  for (const name of ["aster-desktop-bridge", "aster-mcp", "ffmpeg", "ffprobe"]) {
    const file = executable(name);
    assert.ok(existsSync(file), `Missing packaged binary: ${file}`);
    if (universal) run("lipo", [file, "-verify_arch", "arm64", "x86_64"]);
    if (process.platform === "darwin") {
      const dependencies = run("otool", ["-L", file])
        .split("\n")
        .filter((line) => /^\s/.test(line));
      for (const dependency of dependencies) {
        assert.match(
          dependency.trim(),
          /^\/(usr\/lib|System\/Library)\//,
          `Non-system dependency in ${name}: ${dependency}`,
        );
      }
    }
    run(file, [name.startsWith("aster-") ? "--help" : "-version"]);
  }
  for (const name of ["ffmpeg-source.json", "ffmpeg-download.json"]) {
    assert.ok(existsSync(join(bin, name)), `Missing packaged provenance: ${name}`);
  }
  assert.ok(
    readdirSync(bin).some((name) => name.endsWith(".LICENSE")),
    "Missing FFmpeg license",
  );

  const scratch = mkdtempSync(join(tmpdir(), "aster-bundle-smoke-"));
  try {
    const sample = join(scratch, "sample.mp4");
    run(executable("ffmpeg"), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:r=30",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "0.2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      sample,
    ]);
    const probe = JSON.parse(
      run(executable("ffprobe"), ["-v", "error", "-show_streams", "-of", "json", sample]),
    );
    assert.ok(
      probe.streams.some(
        (stream) => stream.codec_name === "h264" && stream.width === 64 && stream.height === 64,
      ),
    );
    assert.ok(probe.streams.some((stream) => stream.codec_name === "aac" && stream.channels === 2));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const release = resolve("release");
const artifacts = readdirSync(release)
  .filter((name) => /\.(exe|dmg|zip|AppImage|deb)$/.test(name))
  .sort();
assert.ok(artifacts.length > 0, "No desktop installers were produced");
const checksums = [];
for (const name of artifacts) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(release, name))) hash.update(chunk);
  checksums.push(`${hash.digest("hex")}  ${name}`);
}
writeFileSync(join(release, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
process.stdout.write(
  `Verified packaged sidecars, H.264/AAC export, and ${artifacts.length} installer checksums\n`,
);
