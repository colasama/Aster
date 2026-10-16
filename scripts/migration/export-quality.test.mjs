import assert from "node:assert/strict";
import test from "node:test";
import { exportQualityMethod, exportQualityPassed, parseExportQuality } from "./export-quality.mjs";

test("quality capability prefers VMAF and requires both fallback filters", () => {
  assert.equal(exportQualityMethod(" ... libvmaf VV->V\n TS. ssim VV->V\n TS. psnr VV->V"), "vmaf");
  assert.equal(exportQualityMethod(" TS. ssim VV->V\n TS. psnr VV->V"), "ssim-psnr");
  for (const text of ["", "libvmaf", " TS. ssim VV->V", " TS. psnr VV->V"])
    assert.throws(() => exportQualityMethod(text));
});

test("fallback requires both thresholds and preserves infinite lossless PSNR", () => {
  const quality = {
    method: "ssim-psnr",
    ssim: { native: 0.998, ts: 1 },
    psnr: { native: 39.5, ts: 40 },
  };
  assert.equal(exportQualityPassed(quality), true);
  quality.ssim.native = 0.9979;
  assert.equal(exportQualityPassed(quality), false);
  quality.ssim.native = 1;
  quality.psnr.native = 39.49;
  assert.equal(exportQualityPassed(quality), false);
  quality.psnr.native = "inf";
  assert.equal(exportQualityPassed(quality), true);
  quality.psnr.ts = "inf";
  assert.equal(exportQualityPassed(quality), true);
  quality.psnr.native = 100;
  assert.equal(exportQualityPassed(quality), false);
  for (const value of [null, NaN, -Infinity, Infinity, "NaN"]) {
    quality.psnr.native = value;
    assert.throws(() => exportQualityPassed(quality));
  }
});

test("filter evidence rejects missing identities, invalid scores and forged aggregates", () => {
  const ssim = "n:1 Y:1 U:1 V:1 All:1 (inf)\nn:2 Y:1 U:1 V:1 All:0.99 (20)\n";
  assert.equal(parseExportQuality("ssim", ssim, 2), 0.995);
  for (const text of [
    ssim.replace("n:2", "n:1"),
    ssim.replace("All:1", "All:NaN"),
    ssim.replace("All:1", "All:2"),
    ssim.split("\n")[0],
  ])
    assert.throws(() => parseExportQuality("ssim", text, 2));
  const psnr = "n:1 mse_avg:6.50 psnr_avg:40.00\nn:2 mse_avg:6.50 psnr_avg:40.00\n";
  assert.equal(
    parseExportQuality("psnr", psnr, 2, "PSNR y:40 u:40 v:40 average:40 min:40 max:40"),
    40,
  );
  for (const log of [
    "",
    "PSNR y:40 u:40 v:40 average:inf min:40 max:40",
    "PSNR y:40 u:40 v:40 average:30 min:40 max:40",
  ])
    assert.throws(() => parseExportQuality("psnr", psnr, 2, log));
});
