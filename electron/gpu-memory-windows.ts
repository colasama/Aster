/** DXGI identifies adapters; WDDM counters report their system-wide resident usage. */
export const WINDOWS_GPU_MEMORY_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AsterGpuMemory {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Description {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Name;
    public uint Vendor, Device, SubSystem, Revision;
    public UIntPtr DedicatedVideo, DedicatedSystem, SharedSystem;
    public uint LuidLow;
    public int LuidHigh;
    public uint Flags;
  }
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int Enumerate(IntPtr factory, uint index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int Describe(IntPtr adapter, out Description description);
  [StructLayout(LayoutKind.Sequential)]
  private struct Architecture {
    public uint NodeIndex;
    public int TileBased, Unified, CacheCoherent;
  }
  public class Adapter {
    public Description Info;
    public bool? Unified;
  }
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int CheckFeature(IntPtr device, uint feature, ref Architecture data, uint size);
  [DllImport("d3d12.dll")]
  private static extern int D3D12CreateDevice(IntPtr adapter, uint level, ref Guid iid, out IntPtr device);
  [DllImport("dxgi.dll")]
  private static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
  private static bool? IsUnified(IntPtr adapter) {
    IntPtr device = IntPtr.Zero;
    try {
      var iid = new Guid("189819f1-1db6-4b57-be54-1821339b85f7");
      // D3D_FEATURE_LEVEL_11_0; ID3D12Device::CheckFeatureSupport is vtable slot 13.
      if (D3D12CreateDevice(adapter, 0xb000, ref iid, out device) < 0) return null;
      var check = (CheckFeature)Marshal.GetDelegateForFunctionPointer(
        Marshal.ReadIntPtr(Marshal.ReadIntPtr(device), 13 * IntPtr.Size), typeof(CheckFeature));
      var data = new Architecture();
      // D3D12_FEATURE_ARCHITECTURE provides UMA even on the original D3D12 runtime.
      if (check(device, 1, ref data, (uint)Marshal.SizeOf(typeof(Architecture))) < 0) return null;
      return data.Unified != 0;
    } catch (DllNotFoundException) { return null; }
      catch (EntryPointNotFoundException) { return null; }
    finally { if (device != IntPtr.Zero) Marshal.Release(device); }
  }
  public static Adapter[] Read() {
    var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IntPtr factory;
    Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref iid, out factory));
    try {
      var enumerate = (Enumerate)Marshal.GetDelegateForFunctionPointer(
        Marshal.ReadIntPtr(Marshal.ReadIntPtr(factory), 12 * IntPtr.Size), typeof(Enumerate));
      var result = new List<Adapter>();
      for (uint index = 0; index < 32; index++) {
        IntPtr adapter;
        int status = enumerate(factory, index, out adapter);
        if (status == unchecked((int)0x887a0002)) break;
        Marshal.ThrowExceptionForHR(status);
        try {
          var describe = (Describe)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(adapter), 10 * IntPtr.Size), typeof(Describe));
          Description description;
          Marshal.ThrowExceptionForHR(describe(adapter, out description));
          if ((description.Flags & 2) == 0)
            result.Add(new Adapter { Info = description, Unified = IsUnified(adapter) });
        } finally { Marshal.Release(adapter); }
      }
      return result.ToArray();
    } finally { Marshal.Release(factory); }
  }
}
'@
$usage = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction SilentlyContinue)
$result = @([AsterGpuMemory]::Read() | ForEach-Object {
  $info = $_.Info
  $key = 'luid_0x{0:x8}_0x{1:x8}_' -f $info.LuidHigh, $info.LuidLow
  $counters = @($usage | Where-Object { $_.Name.StartsWith($key, [StringComparison]::OrdinalIgnoreCase) })
  $dedicatedUsed = $null
  $sharedUsed = $null
  if ($counters.Count -gt 0) {
    $dedicatedUsed = ($counters | Measure-Object -Property DedicatedUsage -Sum).Sum
    $sharedUsed = ($counters | Measure-Object -Property SharedUsage -Sum).Sum
  }
  [PSCustomObject]@{
    name = $info.Name; vendorId = $info.Vendor; deviceId = $info.Device; unified = $_.Unified
    dedicatedBytes = $info.DedicatedVideo.ToUInt64() + $info.DedicatedSystem.ToUInt64()
    sharedBytes = $info.SharedSystem.ToUInt64()
    dedicatedUsedBytes = $dedicatedUsed; sharedUsedBytes = $sharedUsed
  }
})
ConvertTo-Json -InputObject $result -Compress
`;
