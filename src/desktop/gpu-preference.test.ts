// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { AsterDesktopApi } from "./api";
import { requestPreferredGpuAdapter } from "./gpu-preference";
import { defaultAppPreferences } from "./preferences";

afterEach(() => {
  delete window.asterDesktop;
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("requests the default, saved browser, and authoritative desktop GPU preference", async () => {
  const requestAdapter = vi.fn().mockResolvedValue(null);
  vi.stubGlobal("navigator", { gpu: { requestAdapter } });
  await requestPreferredGpuAdapter();
  expect(requestAdapter).toHaveBeenLastCalledWith({ powerPreference: "high-performance" });
  window.localStorage.setItem("aster.gpuPreference", "low-power");
  await requestPreferredGpuAdapter();
  expect(requestAdapter).toHaveBeenLastCalledWith({ powerPreference: "low-power" });
  window.asterDesktop = {
    getPreferences: vi.fn().mockResolvedValue(defaultAppPreferences()),
  } as unknown as AsterDesktopApi;
  await requestPreferredGpuAdapter();
  expect(requestAdapter).toHaveBeenLastCalledWith({ powerPreference: "high-performance" });
  window.asterDesktop.getPreferences = vi.fn().mockResolvedValue({
    ...defaultAppPreferences(),
    gpuPreference: "low-power",
  });
  await requestPreferredGpuAdapter();
  expect(requestAdapter).toHaveBeenLastCalledWith({ powerPreference: "low-power" });
});
