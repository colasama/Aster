export type GpuMemoryBudgetMb = "auto" | number;
export const FALLBACK_GPU_MEMORY_MB = 512;
export const MIN_MANUAL_GPU_MEMORY_MB = 32;

export interface GpuMemoryDevice {
  name: string;
  vendorId?: number;
  deviceId?: number;
  totalMb: number;
  freeMb?: number;
  kind: "dedicated" | "unified";
}

export interface GpuMemorySnapshot {
  adapterKey: string;
  detectedAt: number;
  device?: GpuMemoryDevice;
}

export interface GpuAdapterIdentity {
  vendor: string;
  device: string;
  description: string;
}

export function isGpuMemoryBudget(value: unknown): value is GpuMemoryBudgetMb {
  return (
    value === "auto" ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_MANUAL_GPU_MEMORY_MB)
  );
}

/** Free memory is sampled explicitly, never in the frame loop or inferred from WebGPU limits. */
export function automaticGpuMemoryBudget(device?: GpuMemoryDevice): number {
  if (device?.freeMb === undefined)
    return Math.min(FALLBACK_GPU_MEMORY_MB, device?.totalMb ?? FALLBACK_GPU_MEMORY_MB);
  const free = Math.max(0, Math.min(device.freeMb, device.totalMb));
  const rounded = Math.floor((free - 1024) / 1024) * 1024;
  // Below 2 GiB free, whole-GiB rounding would produce no usable budget.
  return rounded > 0 ? rounded : Math.floor(Math.min(512, free / 2));
}

export function resolveGpuMemoryBudget(value: GpuMemoryBudgetMb, device?: GpuMemoryDevice): number {
  const automatic = automaticGpuMemoryBudget(device);
  if (value === "auto" || !isGpuMemoryBudget(value)) return automatic;
  // Revalidate saved preferences when the project moves to a different GPU or detection fails.
  return Math.min(value, device?.totalMb ?? automatic);
}

export function matchGpuMemoryDevice(
  identity: GpuAdapterIdentity,
  devices: readonly GpuMemoryDevice[],
): GpuMemoryDevice | undefined {
  const vendor = identity.vendor.toLowerCase();
  const vendorId =
    ({ nvidia: 0x10de, amd: 0x1002, intel: 0x8086, apple: 0x106b } as Record<string, number>)[
      vendor
    ] ?? (/^0x[\da-f]+$/iu.test(vendor) ? Number.parseInt(vendor, 16) : undefined);
  const deviceId = /^0x[\da-f]+$/iu.test(identity.device)
    ? Number.parseInt(identity.device, 16)
    : undefined;
  const description = identity.description.trim().toLowerCase();
  const matches = devices.filter((candidate) => {
    if (vendorId !== undefined && candidate.vendorId !== vendorId) return false;
    if (deviceId !== undefined) return candidate.deviceId === deviceId;
    return description
      ? candidate.name.trim().toLowerCase() === description
      : vendorId !== undefined;
  });
  // Identical cards may have different loads; never sum their memory or guess a larger capacity.
  if (matches.length === 0) return undefined;
  const measured = matches.filter((entry) => entry.freeMb !== undefined);
  return {
    ...matches[0],
    totalMb: Math.min(...matches.map((entry) => entry.totalMb)),
    freeMb:
      measured.length > 0 ? Math.min(...measured.map((entry) => entry.freeMb ?? 0)) : undefined,
  };
}
