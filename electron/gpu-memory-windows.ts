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
  [DllImport("dxgi.dll")]
  private static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
  public static Description[] Read() {
    var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IntPtr factory;
    Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref iid, out factory));
    try {
      var enumerate = (Enumerate)Marshal.GetDelegateForFunctionPointer(
        Marshal.ReadIntPtr(Marshal.ReadIntPtr(factory), 12 * IntPtr.Size), typeof(Enumerate));
      var result = new List<Description>();
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
          if ((description.Flags & 2) == 0) result.Add(description);
        } finally { Marshal.Release(adapter); }
      }
      return result.ToArray();
    } finally { Marshal.Release(factory); }
  }
}
'@
$usage = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction SilentlyContinue)
$result = @([AsterGpuMemory]::Read() | ForEach-Object {
  $key = 'luid_0x{0:x8}_0x{1:x8}_' -f $_.LuidHigh, $_.LuidLow
  $counters = @($usage | Where-Object { $_.Name.StartsWith($key, [StringComparison]::OrdinalIgnoreCase) })
  $total = $_.DedicatedVideo.ToUInt64()
  $free = $null
  if ($counters.Count -gt 0) {
    $used = ($counters | Measure-Object -Property DedicatedUsage -Sum).Sum
    $free = [Math]::Max([double]0, [double]$total - $used)
  }
  [PSCustomObject]@{ name = $_.Name; vendorId = $_.Vendor; deviceId = $_.Device; totalBytes = $total; freeBytes = $free; kind = 'dedicated' }
})
ConvertTo-Json -InputObject $result -Compress
`;
