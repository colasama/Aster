import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeGpuPreference } from "../src/core/rendering/gpu-preference.js";
import { migrateAppPreferences } from "../src/desktop/preferences.js";

/** Read before Electron's ready event; GPU process selection requires an app restart. */
export function startupGpuSwitch(userDataDirectory: string): string {
  let preference = normalizeGpuPreference(undefined);
  for (const filename of ["preferences.json", "preferences.json.backup"]) {
    try {
      preference = migrateAppPreferences(
        JSON.parse(readFileSync(join(userDataDirectory, filename), "utf8")),
      ).gpuPreference;
      break;
    } catch (error) {
      // Match the preference store: do not fall back past a newer schema version.
      if (error instanceof Error && error.message.includes("newer than this build")) break;
    }
  }
  return preference === "low-power" ? "force_low_power_gpu" : "force_high_performance_gpu";
}
