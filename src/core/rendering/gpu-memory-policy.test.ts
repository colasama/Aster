import { describe, expect, it } from "vitest";
import {
  automaticGpuMemoryBudget,
  type GpuMemoryDevice,
  isGpuMemoryBudget,
  matchGpuMemoryDevice,
  resolveGpuMemoryBudget,
} from "./gpu-memory-policy";

const device: GpuMemoryDevice = {
  name: "NVIDIA Test",
  vendorId: 0x10de,
  deviceId: 0x1234,
  totalMb: 8192,
  freeMb: 5939,
  kind: "dedicated",
};

describe("GPU memory policy", () => {
  it.each([
    [5939, 4096],
    [5120, 4096],
    [5119, 3072],
    [2048, 1024],
    [2047, 512],
    [600, 300],
    [1, 0],
    [0, 0],
  ])("rounds %i MiB free with headroom to %i MiB", (freeMb, expected) => {
    expect(automaticGpuMemoryBudget({ ...device, freeMb })).toBe(expected);
  });
  it("never substitutes total VRAM for unknown free memory", () => {
    expect(automaticGpuMemoryBudget({ ...device, freeMb: undefined })).toBe(512);
    expect(automaticGpuMemoryBudget({ ...device, totalMb: 256, freeMb: undefined })).toBe(256);
    expect(automaticGpuMemoryBudget()).toBe(512);
  });
  it("allows manual budgets up to physical memory without subtracting a reserve", () => {
    expect(resolveGpuMemoryBudget(6144, device)).toBe(6144);
    expect(resolveGpuMemoryBudget(8192, device)).toBe(8192);
    expect(resolveGpuMemoryBudget(16384, device)).toBe(8192);
    expect(resolveGpuMemoryBudget(6144)).toBe(512);
    for (const value of [NaN, Infinity, -1, 0, 31, 32.5, "6144", null])
      expect(isGpuMemoryBudget(value)).toBe(false);
    expect(isGpuMemoryBudget(6144)).toBe(true);
  });
  it("matches the rendering adapter and conservatively handles identical adapters", () => {
    const identity = { vendor: "nvidia", device: "0x1234", description: "" };
    const other: GpuMemoryDevice = {
      ...device,
      name: "AMD Test",
      vendorId: 0x1002,
      totalMb: 24576,
      freeMb: 22000,
    };
    expect(matchGpuMemoryDevice(identity, [other, device])).toEqual(device);
    expect(
      matchGpuMemoryDevice(identity, [
        device,
        { ...device, freeMb: 3000 },
        { ...device, freeMb: undefined },
      ])?.freeMb,
    ).toBe(3000);
    expect(
      matchGpuMemoryDevice({ ...identity, device: "0x9999" }, [other, device]),
    ).toBeUndefined();
    expect(
      matchGpuMemoryDevice({ vendor: "", device: "", description: "" }, [device]),
    ).toBeUndefined();
  });
});
