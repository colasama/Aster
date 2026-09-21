import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { downloadAsset, validateMediaBinary } from "./download-ffmpeg.mjs";

test("downloads verified bytes, rejects altered assets, and repairs a corrupted cache", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "aster-ffmpeg-download-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const contents = Buffer.from("fixture executable");
  const compressed = gzipSync(contents);
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  let requests = 0;
  let payload = compressed;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/ffmpeg.gz`;
  const cached = join(directory, "ffmpeg.gz");
  assert.deepEqual(await downloadAsset(url, sha256, cached), contents);
  assert.deepEqual(await downloadAsset(url, sha256, cached), contents);
  assert.equal(requests, 1, "Verified cache should avoid another request");
  writeFileSync(cached, "corrupted cache");
  assert.deepEqual(await downloadAsset(url, sha256, cached), contents);
  assert.equal(requests, 2);
  assert.deepEqual(readFileSync(cached), compressed);
  payload = gzipSync(Buffer.from("tampered executable"));
  const rejected = join(directory, "rejected.gz");
  await assert.rejects(downloadAsset(url, sha256, rejected), /SHA-256 mismatch/);
  assert.equal(existsSync(rejected), false, "Unverified bytes must never reach the cache");
});

test("every supported platform has pinned tools, licenses, and build information", () => {
  const { assets } = JSON.parse(
    readFileSync(new URL("ffmpeg-downloads.json", import.meta.url), "utf8"),
  );
  for (const platform of ["win32-x64", "linux-x64", "darwin-x64", "darwin-arm64"]) {
    const archiveType = platform.startsWith("darwin") ? "zip" : "gz";
    for (const name of [
      `ffmpeg-${platform}.${archiveType}`,
      `ffprobe-${platform}.${archiveType}`,
      `${platform}.LICENSE`,
      `${platform}.README`,
    ]) {
      assert.match(assets[name].url, /^https:\/\//);
      assert.match(assets[name].sha256, /^[a-f0-9]{64}$/);
    }
  }
});

test("refuses nonfree FFmpeg payloads before staging either architecture", () => {
  validateMediaBinary(Buffer.from("configuration: --enable-gpl --enable-libx264"));
  assert.throws(
    () => validateMediaBinary(Buffer.from("configuration: --enable-gpl --enable-nonfree")),
    /Refusing to bundle/,
  );
});
