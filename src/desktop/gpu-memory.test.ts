// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsterDesktopApi } from "./api";
import { defaultAppPreferences } from "./preferences";

const adapter = { vendor: "nvidia", device: "0x1234", description: "GPU" };
const device = {
  name: "GPU",
  vendorId: 0x10de,
  deviceId: 0x1234,
  totalMb: 8192,
  freeMb: 6000,
  kind: "dedicated" as const,
};

afterEach(() => {
  delete window.asterDesktop;
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("renderer GPU memory initialization", () => {
  it("reads authoritative desktop preferences for both preview and isolated export initialization", async () => {
    window.localStorage.setItem("aster.gpuMemoryBudgetMb", "128");
    const probe = vi.fn().mockResolvedValue([device]);
    window.asterDesktop = {
      getGpuMemoryDevices: probe,
      getPreferences: vi
        .fn()
        .mockResolvedValue({ ...defaultAppPreferences(), gpuMemoryBudgetMb: 6144 }),
    } as unknown as AsterDesktopApi;
    const { initialRendererGpuMemory } = await import("./gpu-memory");
    const first = await initialRendererGpuMemory(adapter);
    expect(first.preference).toBe(6144);
    expect(first.memory.device).toEqual(device);
    probe.mockResolvedValue([{ ...device, freeMb: 4000 }]);
    const second = await initialRendererGpuMemory(adapter);
    expect(second.preference).toBe(6144);
    expect(second.memory.device?.freeMb).toBe(4000);
  });
  it("coalesces pending probes but refreshes explicitly and never returns a different adapter", async () => {
    let finish: (devices: (typeof device)[]) => void = () => undefined;
    const probe = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue([device]);
    window.asterDesktop = { getGpuMemoryDevices: probe } as unknown as AsterDesktopApi;
    const { detectGpuMemory } = await import("./gpu-memory");
    const first = detectGpuMemory(adapter);
    const same = detectGpuMemory(adapter);
    const other = detectGpuMemory({ ...adapter, device: "0x9999" });
    finish([device]);
    expect((await first).device).toEqual(device);
    expect(await same).toEqual(await first);
    expect((await other).device).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
    await detectGpuMemory(adapter);
    expect(probe).toHaveBeenCalledTimes(3);
  });
  it("falls back safely when IPC and local storage are unavailable", async () => {
    window.asterDesktop = {
      getGpuMemoryDevices: vi.fn().mockRejectedValue(new Error("Unavailable")),
      getPreferences: vi.fn().mockRejectedValue(new Error("Unavailable")),
    } as unknown as AsterDesktopApi;
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("Denied");
    });
    const { initialRendererGpuMemory } = await import("./gpu-memory");
    const result = await initialRendererGpuMemory(adapter);
    expect(result.preference).toBe("auto");
    expect(result.memory.device).toBeUndefined();
  });
});
