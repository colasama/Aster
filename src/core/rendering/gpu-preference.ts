export type GpuPreference = "high-performance" | "low-power";

export function normalizeGpuPreference(value: unknown): GpuPreference {
  return value === "low-power" ? "low-power" : "high-performance";
}
