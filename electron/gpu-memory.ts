import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GpuMemoryDevice } from "../src/core/rendering/gpu-memory-policy.js";
import { WINDOWS_GPU_MEMORY_QUERY } from "./gpu-memory-windows.js";

const execute = promisify(execFile);
let pending: Promise<GpuMemoryDevice[]> | undefined;

/** Coalesce simultaneous preview/settings/export probes; every subsequent probe is fresh. */
export function detectGpuMemoryDevices(): Promise<GpuMemoryDevice[]> {
  pending ??= readDevices()
    .catch(() => [])
    .finally(() => {
      pending = undefined;
    });
  return pending;
}

async function command(file: string, args: string[]): Promise<string> {
  const { stdout } = await execute(file, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function readDevices(): Promise<GpuMemoryDevice[]> {
  if (process.platform === "win32") {
    const shell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    return parseGpuMemoryDevices(
      JSON.parse(
        await command(shell, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_GPU_MEMORY_QUERY,
        ]),
      ),
    );
  }
  if (process.platform === "darwin") {
    const info = JSON.parse(
      await command("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"]),
    );
    return parseMacGpuMemory(info, totalmem());
  }
  if (process.platform !== "linux") return [];
  const devices: GpuMemoryDevice[] = [];
  // NVIDIA's driver exposes total/free framebuffer memory without creating a GPU context.
  try {
    const output = await command("nvidia-smi", [
      "--query-gpu=name,pci.device_id,memory.total,memory.free",
      "--format=csv,noheader,nounits",
    ]);
    for (const line of output.trim().split("\n")) {
      const [name, pci, total, free] = line.split(",").map((part) => part.trim());
      const id = Number.parseInt(pci, 16);
      devices.push(
        ...parseGpuMemoryDevices([
          {
            name,
            vendorId: id & 0xffff,
            deviceId: id >>> 16,
            totalBytes: Number(total) * 1024 ** 2,
            freeBytes: Number(free) * 1024 ** 2,
            kind: "dedicated",
          },
        ]),
      );
    }
  } catch {
    /* NVIDIA's utility is absent on non-NVIDIA systems. */
  }
  try {
    const cards = (await readdir("/sys/class/drm")).filter((name) => /^card\d+$/u.test(name));
    for (const card of cards) {
      try {
        const root = `/sys/class/drm/${card}/device`;
        const [total, used, vendor, device] = await Promise.all([
          readFile(`${root}/mem_info_vram_total`, "utf8"),
          readFile(`${root}/mem_info_vram_used`, "utf8"),
          readFile(`${root}/vendor`, "utf8"),
          readFile(`${root}/device`, "utf8"),
        ]);
        devices.push(
          ...parseGpuMemoryDevices([
            {
              name: card,
              vendorId: Number(vendor.trim()),
              deviceId: Number(device.trim()),
              totalBytes: Number(total),
              freeBytes: Math.max(0, Number(total) - Number(used)),
              kind: "dedicated",
            },
          ]),
        );
      } catch {
        /* Not every DRM driver exposes dedicated VRAM counters. */
      }
    }
  } catch {
    /* Sandboxed or headless Linux may not expose DRM devices. */
  }
  return devices;
}

export function parseGpuMemoryDevices(value: unknown): GpuMemoryDevice[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      typeof entry.totalBytes !== "number"
    )
      return [];
    const totalMb = Math.floor(entry.totalBytes / 1024 ** 2);
    if (!Number.isSafeInteger(totalMb) || totalMb < 1) return [];
    const freeMb =
      typeof entry.freeBytes === "number" && Number.isFinite(entry.freeBytes)
        ? Math.floor(Math.max(0, Math.min(totalMb, entry.freeBytes / 1024 ** 2)))
        : undefined;
    return [
      {
        name: entry.name.slice(0, 256),
        totalMb,
        freeMb,
        vendorId: Number.isSafeInteger(entry.vendorId) ? entry.vendorId : undefined,
        deviceId: Number.isSafeInteger(entry.deviceId) ? entry.deviceId : undefined,
        kind: entry.kind === "unified" ? ("unified" as const) : ("dedicated" as const),
      },
    ];
  });
}

export function parseMacGpuMemory(value: unknown, systemBytes: number): GpuMemoryDevice[] {
  const displays = (value as { SPDisplaysDataType?: unknown } | undefined)?.SPDisplaysDataType;
  if (!Array.isArray(displays)) return [];
  return parseGpuMemoryDevices(
    displays
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const name = entry.sppci_model ?? entry._name;
        const unified = typeof name === "string" && /^Apple\s/u.test(name);
        const vram = String(entry.spdisplays_vram ?? entry.spdisplays_vram_shared ?? "").match(
          /^([\d.]+)\s*(GB|MB)$/iu,
        );
        return {
          name,
          vendorId: unified
            ? 0x106b
            : Number.parseInt(String(entry.spdisplays_vendor).match(/0x[\da-f]+/iu)?.[0] ?? "", 16),
          deviceId: Number.parseInt(entry.spdisplays_device_id ?? "", 16),
          totalBytes: unified
            ? systemBytes
            : vram
              ? Number(vram[1]) * (vram[2].toUpperCase() === "GB" ? 1024 ** 3 : 1024 ** 2)
              : 0,
          // Metal's recommended working set is not a system-wide free-memory counter.
          freeBytes: undefined,
          kind: unified ? "unified" : "dedicated",
        };
      }),
  );
}
