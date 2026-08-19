import { describe, expect, it } from "vitest";
import { parseCubeLut } from "./cube-lut";

const IDENTITY_2 = `
TITLE "Identity 2"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe(".cube LUT parser", () => {
  it("parses a bounded 3D LUT in red-fastest texture order", () => {
    const lut = parseCubeLut(IDENTITY_2, "identity.cube");
    expect(lut.size).toBe(2);
    expect(lut.title).toBe("Identity 2");
    expect(lut.data).toHaveLength(24);
    expect(lut.data.slice(3, 6)).toEqual([1, 0, 0]);
    expect(lut.checksum).toMatch(/^[a-f0-9]{8}$/);
  });

  it("rejects incomplete, one-dimensional, or invalid-domain files", () => {
    expect(() => parseCubeLut("LUT_1D_SIZE 2\n0 0 0\n1 1 1")).toThrow("Unsupported");
    expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 0 0")).toThrow("Expected 8 LUT rows");
    expect(() => parseCubeLut(IDENTITY_2.replace("DOMAIN_MAX 1 1 1", "DOMAIN_MAX 0 1 1"))).toThrow(
      "DOMAIN_MAX",
    );
  });
});
