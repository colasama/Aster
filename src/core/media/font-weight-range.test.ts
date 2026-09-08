import { expect, it } from "vitest";
import { fontWeightRange } from "./font-weight-range";

function variableFont() {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, 1);
  view.setUint32(12, 0x66766172);
  view.setUint32(20, 28);
  view.setUint32(24, 36);
  view.setUint16(32, 16);
  view.setUint16(36, 1);
  view.setUint16(38, 20);
  view.setUint32(44, 0x77676874);
  view.setInt32(48, 100 * 65536);
  view.setInt32(52, 400 * 65536);
  view.setInt32(56, 900 * 65536);
  return bytes;
}

it("detects variable weights from bounded SFNT views and ignores truncated tables", () => {
  const bytes = variableFont();
  expect(fontWeightRange(bytes)).toEqual([100, 900]);
  const padded = new Uint8Array(80);
  padded.set(bytes, 8);
  expect(fontWeightRange(padded.subarray(8, 72))).toEqual([100, 900]);
  for (let size = 0; size < bytes.length; size++)
    expect(fontWeightRange(bytes.subarray(0, size))).toBeUndefined();
  new DataView(bytes.buffer).setUint32(20, 0xffffffff);
  expect(fontWeightRange(bytes)).toBeUndefined();
});
