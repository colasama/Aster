import { describe, expect, it, vi } from "vitest";
import {
  type CaptureFontFingerprint,
  type CaptureLocalFont,
  captureFontFingerprint,
  withCaptureFontRecheck,
} from "./capture-fonts";
import type { ParityCaptureApi } from "./capture-protocol";

function font(family: string, bytes: number[]): CaptureLocalFont {
  return {
    family,
    fullName: `${family} Regular`,
    postscriptName: `${family}-Regular`,
    style: "Regular",
    blob: async () => new Blob([new Uint8Array(bytes)]),
  };
}

describe("system font provenance", () => {
  it("is stable across enumeration order and exposes only aggregate identity", async () => {
    const first = font("Alpha", [0, 1, 2]);
    const second = font("Beta", [3, 4, 5]);
    const left = await captureFontFingerprint(async () => [first, second]);
    const right = await captureFontFingerprint(async () => [second, first]);
    expect(left).toEqual(right);
    expect(left).toEqual({
      status: "available",
      count: 2,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(left)).not.toMatch(/Alpha|Beta|Regular/);
  });

  it("invalidates identity when font bytes or metadata change", async () => {
    const original = await captureFontFingerprint(async () => [font("Alpha", [1, 2, 3])]);
    const bytes = await captureFontFingerprint(async () => [font("Alpha", [1, 2, 4])]);
    const renamed = await captureFontFingerprint(async () => [font("Beta", [1, 2, 3])]);
    expect(original.status).toBe("available");
    expect(bytes).not.toEqual(original);
    expect(renamed).not.toEqual(original);
  });

  it("does not accept partial inventory when one font payload fails", async () => {
    const invalid = font("Private font name", [1]);
    invalid.blob = async () => {
      throw new Error("Private font path");
    };
    const result = await captureFontFingerprint(async () => [font("Alpha", [2]), invalid]);
    expect(result).toEqual({
      status: "unavailable",
      reason: "Local font payload could not be read",
    });
    expect(JSON.stringify(result)).not.toContain("Private");
    await expect(captureFontFingerprint(async () => [font("Empty", [])])).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("marks rejected font access unavailable without leaking the rejection payload", async () => {
    const result = await captureFontFingerprint(async () => {
      throw new Error("sensitive data");
    });
    expect(result).toEqual({ status: "unavailable", reason: "Local font inventory query failed" });
  });

  it("reports changed fonts before final publication and retains unchanged unavailable state", async () => {
    const api: ParityCaptureApi = {
      ready: vi.fn(async () => undefined),
      take: vi.fn(async () => null),
      frame: vi.fn(async () => undefined),
      completeCase: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      done: vi.fn(async () => undefined),
    };
    const initial: CaptureFontFingerprint = { status: "available", count: 1, sha256: "initial" };
    await withCaptureFontRecheck(api, initial, async () => ({
      ...initial,
      sha256: "changed",
    })).done();
    expect(api.fail).toHaveBeenCalledOnce();
    expect(vi.mocked(api.fail).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.done).mock.invocationCallOrder[0],
    );
    vi.mocked(api.fail).mockClear();
    const unavailable: CaptureFontFingerprint = { status: "unavailable", reason: "no font API" };
    await withCaptureFontRecheck(api, unavailable, async () => unavailable).done();
    expect(api.fail).not.toHaveBeenCalled();
    await withCaptureFontRecheck(api, initial, async () => unavailable).done();
    expect(api.fail).toHaveBeenCalledOnce();
  });
});
