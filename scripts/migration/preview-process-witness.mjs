import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { hashFile } from "./source.mjs";

/** Read only the native preview producers owned by this smoke test's application tree. */
export async function captureNativePreviewProcesses(binary, rootProcessId) {
  assert.equal(process.platform, "win32");
  assert(Number.isSafeInteger(rootProcessId) && rootProcessId > 0);
  const path = resolve(binary);
  const query = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rootProcess = [int]$env:ASTER_PREVIEW_WITNESS_ROOT
$processes = @(Get-CimInstance Win32_Process)
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($rootProcess)
do {
  $previousCount = $owned.Count
  foreach ($entry in $processes) {
    if ($owned.Contains([int]$entry.ParentProcessId)) { [void]$owned.Add([int]$entry.ProcessId) }
  }
} while ($previousCount -ne $owned.Count)
$previewProcesses = @($processes | Where-Object {
  $owned.Contains([int]$_.ProcessId) -and
  $_.ExecutablePath -eq $env:ASTER_PREVIEW_WITNESS_BINARY -and
  $_.CommandLine -match '(?:^|\s)preview-project(?:\s|$)'
} | ForEach-Object {
  $consumer = [regex]::Match($_.CommandLine, '--consumer-pid\s+(\d+)')
  if (-not $consumer.Success) { throw 'Preview producer has no consumer identity' }
  $consumerProcess = [int]$consumer.Groups[1].Value
  @{process_id=[int]$_.ProcessId;parent_process_id=[int]$_.ParentProcessId;
    consumer_process_id=$consumerProcess;consumer_owned=$owned.Contains($consumerProcess);
    executable=$_.ExecutablePath}
})
ConvertTo-Json -InputObject $previewProcesses -Depth 4 -Compress
`;
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", query],
    {
      windowsHide: true,
      timeout: 15000,
      encoding: "utf8",
      env: {
        ...process.env,
        ASTER_PREVIEW_WITNESS_ROOT: String(rootProcessId),
        ASTER_PREVIEW_WITNESS_BINARY: path,
      },
    },
  );
  const producers = JSON.parse(stdout);
  assert(Array.isArray(producers) && producers.length > 0, "No owned native preview producer");
  for (const producer of producers) {
    assert.equal(producer.consumer_owned, true);
    assert.equal(producer.parent_process_id, producer.consumer_process_id);
    assert.equal(resolve(producer.executable).toLowerCase(), path.toLowerCase());
  }
  return {
    status: "passed",
    observed_at: new Date().toISOString(),
    owner_process_id: rootProcessId,
    binary: { path, sha256: await hashFile(path) },
    producers,
  };
}
