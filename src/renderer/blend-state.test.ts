import { describe, expect, it } from "vitest";
import { gpuBlendState } from "./blend-state";

describe("premultiplied alpha GPU compositing", () => {
  it("uses source-over alpha independently of the color blend mode", () => {
    for (const mode of ["normal", "add", "multiply", "screen", "overlay"] as const) {
      expect(gpuBlendState(mode).alpha).toEqual({
        srcFactor: "one",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      });
    }
  });

  it("uses premultiplied source-over for normal and overlay fallback", () => {
    const expected = {
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    };
    expect(gpuBlendState("normal").color).toEqual(expected);
    expect(gpuBlendState("overlay").color).toEqual(expected);
  });

  it("maps additive, multiply, and screen to stable hardware factors", () => {
    expect(gpuBlendState("add").color).toMatchObject({ srcFactor: "one", dstFactor: "one" });
    expect(gpuBlendState("multiply").color).toMatchObject({
      srcFactor: "dst",
      dstFactor: "zero",
    });
    expect(gpuBlendState("screen").color).toMatchObject({
      srcFactor: "one",
      dstFactor: "one-minus-src",
    });
  });
});
