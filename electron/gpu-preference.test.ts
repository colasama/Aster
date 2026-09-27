import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AppPreferencesStore } from "./app-preferences";
import { startupGpuSwitch } from "./gpu-preference";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("applies saved GPU selection at startup and recovers the preference backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-gpu-preference-"));
  roots.push(root);
  expect(startupGpuSwitch(root)).toBe("force_high_performance_gpu");
  const store = new AppPreferencesStore(root);
  await store.initialize();
  await store.updateUserPreferences({ gpuPreference: "low-power" });
  expect(startupGpuSwitch(root)).toBe("force_low_power_gpu");
  await store.updateUserPreferences({ gpuPreference: "high-performance" });
  expect(startupGpuSwitch(root)).toBe("force_high_performance_gpu");
  await writeFile(join(root, "preferences.json"), "{");
  expect(startupGpuSwitch(root)).toBe("force_low_power_gpu");
  await writeFile(join(root, "preferences.json"), JSON.stringify({ schemaVersion: 99 }));
  expect(startupGpuSwitch(root)).toBe("force_high_performance_gpu");
});
