import { describe, expect, it } from "vitest";
import { packTextureUploadRows, planTextureUpload } from "./texture-upload-batch";

describe("texture upload staging layout", () => {
  it("aligns rows and consecutive uploads for WebGPU copies", () => {
    const first = planTextureUpload(65, 2);
    const second = planTextureUpload(1, 1, first.offset + first.byteLength);
    expect(first).toEqual({ offset: 0, bytesPerRow: 512, byteLength: 1_024 });
    expect(second).toEqual({ offset: 1_024, bytesPerRow: 256, byteLength: 256 });
  });

  it("packs RGBA rows without leaking into alignment padding", () => {
    const plan = planTextureUpload(2, 2, 256);
    const destination = new Uint8Array(plan.offset + plan.byteLength).fill(0xee);
    const source = Uint8Array.from({ length: 16 }, (_, index) => index);
    packTextureUploadRows(destination, plan, source, 2, 2);

    expect([...destination.slice(256, 264)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(destination[264]).toBe(0xee);
    expect([...destination.slice(512, 520)]).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });
});
