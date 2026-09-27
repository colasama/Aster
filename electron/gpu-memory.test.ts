import { describe, expect, it } from "vitest";
import {
  automaticGpuMemoryBudget,
  matchGpuMemoryDevice,
  resolveGpuMemoryBudget,
} from "../src/core/rendering/gpu-memory-policy";
import { parseGpuMemoryDevices, parseMacGpuMemory, parseWindowsGpuMemory } from "./gpu-memory";

const MiB = 1024 ** 2;
const uma = {
  name: "AMD Radeon 780M",
  vendorId: 0x1002,
  deviceId: 0x15bf,
  unified: true,
  dedicatedBytes: 512 * MiB,
  sharedBytes: 16 * 1024 * MiB,
  dedicatedUsedBytes: 128 * MiB,
  sharedUsedBytes: 2 * 1024 * MiB,
};

describe("native GPU memory records", () => {
  it("includes UMA shared capacity and bounds its free estimate by available system RAM", () => {
    const devices = parseWindowsGpuMemory([uma], 6 * 1024 * MiB);
    const device = matchGpuMemoryDevice(
      { vendor: "amd", device: "0x15bf", description: "" },
      devices,
    );
    expect(device).toMatchObject({ totalMb: 16896, freeMb: 6528, kind: "unified" });
    expect(automaticGpuMemoryBudget(device)).toBe(5120);
    expect(resolveGpuMemoryBudget(8192, device)).toBe(8192);
    expect(resolveGpuMemoryBudget(32768, device)).toBe(16896);
    expect(parseWindowsGpuMemory([uma], 32 * 1024 * MiB)[0].freeMb).toBe(14720);
    expect(parseWindowsGpuMemory([uma], 0)[0].freeMb).toBe(384);
  });
  it("detects UMA with zero or large firmware reservations without a capacity heuristic", () => {
    expect(
      parseWindowsGpuMemory(
        [{ ...uma, dedicatedBytes: 0, dedicatedUsedBytes: 0 }],
        8 * 1024 * MiB,
      )[0],
    ).toMatchObject({ totalMb: 16384, freeMb: 8192, kind: "unified" });
    expect(
      parseWindowsGpuMemory([{ ...uma, dedicatedBytes: 8 * 1024 * MiB }], 8 * 1024 * MiB)[0],
    ).toMatchObject({ totalMb: 24576, kind: "unified" });
  });
  it.each([false, null, undefined])("does not add shared memory when UMA is %s", (unified) => {
    expect(parseWindowsGpuMemory([{ ...uma, unified }], 8 * 1024 * MiB)[0]).toMatchObject({
      totalMb: 512,
      freeMb: 384,
      kind: "dedicated",
    });
  });
  it("keeps missing counters unknown and clamps exhausted UMA segments separately", () => {
    for (const record of [
      { ...uma, dedicatedUsedBytes: null },
      { ...uma, sharedUsedBytes: null },
      { ...uma, sharedUsedBytes: -1 },
    ]) {
      const device = parseWindowsGpuMemory([record], 8 * 1024 * MiB)[0];
      expect(device.freeMb).toBeUndefined();
      expect(automaticGpuMemoryBudget(device)).toBe(512);
    }
    expect(parseWindowsGpuMemory([uma], NaN)[0].freeMb).toBeUndefined();
    expect(
      parseWindowsGpuMemory(
        [{ ...uma, dedicatedUsedBytes: 1024 * MiB, sharedUsedBytes: 32 * 1024 * MiB }],
        8 * 1024 * MiB,
      )[0].freeMb,
    ).toBe(0);
    expect(parseWindowsGpuMemory([null, {}, { ...uma, sharedBytes: Infinity }], 0)).toEqual([]);
  });
  it("preserves capacities above 4 GiB and distinguishes missing/free zero", () => {
    const record = { name: "GPU", totalBytes: 24 * 1024 ** 3, freeBytes: 17 * 1024 ** 3 };
    expect(parseGpuMemoryDevices([record])[0]).toMatchObject({ totalMb: 24576, freeMb: 17408 });
    expect(parseGpuMemoryDevices([{ ...record, freeBytes: null }])[0].freeMb).toBeUndefined();
    expect(parseGpuMemoryDevices([{ ...record, freeBytes: 0 }])[0].freeMb).toBe(0);
    expect(parseGpuMemoryDevices([{ ...record, freeBytes: -1 }])[0].freeMb).toBe(0);
    expect(parseGpuMemoryDevices([{ ...record, freeBytes: 50 * 1024 ** 3 }])[0].freeMb).toBe(24576);
    expect(
      parseGpuMemoryDevices([
        null,
        {},
        { ...record, totalBytes: Infinity },
        { ...record, totalBytes: "1024" },
      ]),
    ).toEqual([]);
  });
  it("marks Apple shared memory explicitly without inventing a free-memory measurement", () => {
    expect(
      parseMacGpuMemory(
        { SPDisplaysDataType: [null, { sppci_model: "Apple M4" }] },
        16 * 1024 ** 3,
      ),
    ).toEqual([
      {
        name: "Apple M4",
        vendorId: 0x106b,
        deviceId: undefined,
        totalMb: 16384,
        freeMb: undefined,
        kind: "unified",
      },
    ]);
    expect(
      parseMacGpuMemory(
        {
          SPDisplaysDataType: [
            {
              sppci_model: "AMD Radeon",
              spdisplays_vram: "8 GB",
              spdisplays_vendor: "AMD (0x1002)",
              spdisplays_device_id: "0x1234",
            },
          ],
        },
        32 * 1024 ** 3,
      )[0],
    ).toMatchObject({
      totalMb: 8192,
      freeMb: undefined,
      vendorId: 0x1002,
      deviceId: 0x1234,
      kind: "dedicated",
    });
  });
});
