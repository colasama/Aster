import { describe, expect, it } from "vitest";
import { parseGpuMemoryDevices, parseMacGpuMemory } from "./gpu-memory";

describe("native GPU memory records", () => {
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
