import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

// Every query and projection is read-only. Raw CIM objects and stderr are never retained.
export const hardwareQuery = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$failures = [System.Collections.Generic.List[string]]::new()
function Read-Cim($class) {
  try { @(Get-CimInstance -ClassName $class -ErrorAction Stop) }
  catch { $failures.Add($class); @() }
}
$os = @(Read-Cim 'Win32_OperatingSystem') | Select-Object -First 1
$cpus = @(Read-Cim 'Win32_Processor' | ForEach-Object {
  @{name=$_.Name;physicalCores=$_.NumberOfCores;logicalProcessors=$_.NumberOfLogicalProcessors}
})
$memory = @(Read-Cim 'Win32_PhysicalMemory' | ForEach-Object {
  @{capacityBytes=$_.Capacity;configuredClockMHz=$_.ConfiguredClockSpeed}
})
$gpus = @(Read-Cim 'Win32_VideoController' | ForEach-Object {
  @{name=$_.Name;driverVersion=$_.DriverVersion}
})
$displays = @()
$ac = $null
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AsterPerformanceConditions {
  [StructLayout(LayoutKind.Sequential)] public struct PowerStatus {
    public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
    public uint BatteryLifeTime, BatteryFullLifeTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct DisplayDevice {
    public uint Size;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Id;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Key;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct DisplayMode {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Name;
    public ushort SpecVersion, DriverVersion, Size, DriverExtra;
    public uint Fields;
    public int X, Y;
    public uint Orientation, FixedOutput;
    public short Color, Duplex, YResolution, TTOption, Collate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string FormName;
    public ushort LogPixels;
    public uint BitsPerPixel, Width, Height, Flags, Frequency;
    public uint ICMMethod, ICMIntent, MediaType, DitherType, Reserved1, Reserved2, PanningWidth, PanningHeight;
  }
  public class Display {
    public int index, x, y;
    public bool primary;
    public uint width, height, refreshHz, bitsPerPixel, orientation;
  }
  [DllImport("kernel32.dll")] private static extern bool GetSystemPowerStatus(out PowerStatus status);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool EnumDisplayDevices(
    string name, uint index, ref DisplayDevice device, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool EnumDisplaySettings(
    string name, int mode, ref DisplayMode settings);
  public static bool? ReadAc() {
    PowerStatus status;
    if (!GetSystemPowerStatus(out status) || status.ACLineStatus > 1) return null;
    return status.ACLineStatus == 1;
  }
  public static Display[] ReadDisplays() {
    var result = new List<Display>();
    for (uint index = 0; index < 64; index++) {
      var device = new DisplayDevice { Size=(uint)Marshal.SizeOf(typeof(DisplayDevice)) };
      if (!EnumDisplayDevices(null, index, ref device, 0)) break;
      if ((device.Flags & 1) == 0 || (device.Flags & 8) != 0) continue;
      var mode = new DisplayMode { Size=(ushort)Marshal.SizeOf(typeof(DisplayMode)) };
      if (!EnumDisplaySettings(device.Name, -1, ref mode))
        throw new InvalidOperationException("Display mode unavailable");
      result.Add(new Display { index=result.Count, primary=(device.Flags & 4) != 0,
        x=mode.X, y=mode.Y, width=mode.Width, height=mode.Height, refreshHz=mode.Frequency,
        bitsPerPixel=mode.BitsPerPixel, orientation=mode.Orientation });
    }
    return result.ToArray();
  }
}
'@
  $ac = [AsterPerformanceConditions]::ReadAc()
  try { $displays = @([AsterPerformanceConditions]::ReadDisplays()) }
  catch { $failures.Add('EnumDisplaySettings') }
} catch { $failures.Add('WindowsRunConditions') }
$scheme = $null
try {
  $schemeOutput = & "$env:SystemRoot\System32\powercfg.exe" /getactivescheme 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'powercfg failed' }
  $match = [regex]::Match(($schemeOutput -join ' '), '[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}')
  if (!$match.Success) { throw 'powercfg returned no scheme' }
  $scheme = $match.Value.ToLowerInvariant()
} catch { $failures.Add('powercfg/getactivescheme') }
[ordered]@{
  operatingSystem=@{name=$os.Caption;version=$os.Version;build=$os.BuildNumber;architecture=$os.OSArchitecture}
  cpu=$cpus;memoryModules=$memory;totalVisibleBytes=($os.TotalVisibleMemorySize * 1024)
  graphicsAdapters=$gpus;displays=$displays;acConnected=$ac;activeSchemeGuid=$scheme
  errors=@($failures)
} | ConvertTo-Json -Depth 6 -Compress
`;

function string(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value, minimum = 1) {
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function normalize(raw, platform, architecture, capturedAt, failure = null) {
  const cpus = array(raw.cpu).map((cpu) => ({
    name: string(cpu.name),
    physicalCores: number(cpu.physicalCores),
    logicalProcessors: number(cpu.logicalProcessors),
  }));
  const modules = array(raw.memoryModules).map((module) => ({
    capacityBytes: number(module.capacityBytes),
    configuredClockMHz: number(module.configuredClockMHz),
  }));
  const gpus = array(raw.graphicsAdapters).map((gpu) => ({
    name: string(gpu.name),
    driverVersion: string(gpu.driverVersion),
  }));
  const displays = array(raw.displays).map((display, index) => ({
    index,
    primary: typeof display.primary === "boolean" ? display.primary : null,
    x: Number.isSafeInteger(display.x) ? display.x : null,
    y: Number.isSafeInteger(display.y) ? display.y : null,
    width: number(display.width),
    height: number(display.height),
    refreshHz: number(display.refreshHz, 2),
    bitsPerPixel: number(display.bitsPerPixel),
    orientation: number(display.orientation, 0),
  }));
  const scheme = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(raw.activeSchemeGuid)
    ? raw.activeSchemeGuid
    : null;
  const schemeNames = {
    "381b4222-f694-41f0-9685-ff5bb260df2e": "Balanced",
    "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c": "High performance",
    "a1841308-3541-4fab-bc81-f71556f20b4a": "Power saver",
  };
  const errors = array(raw.errors).filter((entry) =>
    [
      "Win32_OperatingSystem",
      "Win32_Processor",
      "Win32_PhysicalMemory",
      "Win32_VideoController",
      "EnumDisplaySettings",
      "WindowsRunConditions",
      "powercfg/getactivescheme",
    ].includes(entry),
  );
  if (failure) errors.push(failure);
  const ac = typeof raw.acConnected === "boolean" ? raw.acConnected : null;
  const reasons = [];
  if (platform !== "win32") reasons.push("unsupported-platform");
  if (ac !== true) reasons.push(ac === false ? "ac-power-disconnected" : "ac-power-unknown");
  if (!scheme) reasons.push("active-power-scheme-unknown");
  if (!string(raw.operatingSystem?.version) || !string(raw.operatingSystem?.build))
    reasons.push("os-inventory-incomplete");
  if (!cpus.length || cpus.some((cpu) => !cpu.name || !cpu.logicalProcessors || !cpu.physicalCores))
    reasons.push("cpu-inventory-incomplete");
  if (!modules.length || modules.some((module) => !module.capacityBytes))
    reasons.push("memory-inventory-incomplete");
  if (!gpus.length || gpus.some((gpu) => !gpu.name || !gpu.driverVersion))
    reasons.push("gpu-inventory-incomplete");
  if (
    !displays.length ||
    displays.some((display) => !display.width || !display.height || !display.refreshHz)
  )
    reasons.push("display-inventory-incomplete");
  if (errors.length) reasons.push("capture-query-failed");
  return {
    schemaVersion: 1,
    capturedAt,
    platform,
    operatingSystem: {
      name: string(raw.operatingSystem?.name),
      version: string(raw.operatingSystem?.version),
      build: string(raw.operatingSystem?.build),
      architecture: string(raw.operatingSystem?.architecture),
      processArchitecture: architecture,
    },
    cpu: cpus,
    memory: {
      physicalBytes:
        modules.length && modules.every((module) => module.capacityBytes)
          ? modules.reduce((sum, module) => sum + module.capacityBytes, 0)
          : null,
      modules,
      totalVisibleBytes: number(raw.totalVisibleBytes),
    },
    graphicsAdapters: gpus,
    displays,
    power: {
      acConnected: ac,
      activeSchemeGuid: scheme,
      activeSchemeName: schemeNames[scheme] ?? null,
      windowsPowerMode: null,
      windowsPowerModeReason:
        "The active power scheme does not establish the Windows power-mode overlay",
    },
    runConditions: {
      acPowerRequired: true,
      acPowerSatisfied: ac === null ? null : ac,
      baselineEligible: reasons.length === 0,
      eligibilityScope:
        "Hardware inventory and AC power only; application adapter, workload, warm-up and quality require separate validation",
      reasons,
      adapterSelectionVerified: false,
      backgroundWorkloadsVerified: false,
      thermalStateVerified: false,
    },
    collection: {
      status: errors.length ? "partial" : "complete",
      errors,
      sources: [
        "Windows CIM",
        "GetSystemPowerStatus",
        "EnumDisplayDevices/EnumDisplaySettings",
        "powercfg /getactivescheme",
      ],
    },
    privacy: {
      hostnameIncluded: false,
      userNameIncluded: false,
      deviceSerialIncluded: false,
      hardwareInstanceIdsIncluded: false,
      processNamesIncluded: false,
    },
  };
}

export async function capturePerformanceHardware(root, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const capturedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  if (platform !== "win32")
    return normalize({}, platform, architecture, capturedAt, "unsupported-platform");
  try {
    const run = dependencies.execFile ?? promisify(execFile);
    const { stdout } = await run(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(hardwareQuery, "utf16le").toString("base64"),
      ],
      { cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024, encoding: "utf8" },
    );
    return normalize(JSON.parse(stdout.replace(/^\uFEFF/, "")), platform, architecture, capturedAt);
  } catch {
    // Child error strings can contain machine paths, usernames or raw CIM diagnostics.
    return normalize({}, platform, architecture, capturedAt, "hardware-query-failed");
  }
}
