import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Run against the packaged application: pnpm artifact:build --dir, then node scripts/automation-smoke.mjs.
const root = resolve(import.meta.dirname, "..");
const binary = process.argv[2] ?? join(root, "release", "win-unpacked", "Aster.exe");
const background = process.argv.includes("--background");
const output = join(root, "artifacts", `automation-smoke-${Date.now()}`);
await mkdir(output, { recursive: true });
const port = await freePort();
const environment = {
  ...process.env,
  ASTER_AUTOMATION_PORT: String(port),
  ASTER_AUTOMATION_ENABLED: "1",
};
delete environment.ELECTRON_RUN_AS_NODE;
const app = background
  ? undefined
  : spawn(binary, [`--user-data-dir=${join(output, "profile")}`], {
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
let appLog = "";
app?.stdout.on("data", (data) => {
  appLog = (appLog + data).slice(-512 * 1024);
});
app?.stderr.on("data", (data) => {
  appLog = (appLog + data).slice(-512 * 1024);
});
let launchError;
app?.on("error", (error) => {
  launchError = error;
});
const transport = new StdioClientTransport({
  command: join(dirname(binary), "resources", "bin", "aster-mcp.exe"),
  args: background ? ["--background"] : [],
  env: environment,
  stderr: "pipe",
});
const client = new Client({ name: "aster-packaged-smoke", version: "0.3.2" });
const report = { output, background, steps: [] };
transport.stderr?.on("data", (data) => {
  appLog = (appLog + data).slice(-512 * 1024);
});

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 125_000 });
  if (result.isError)
    throw new Error(`${name}: ${result.content.map((item) => item.text ?? "").join(" ")}`);
  const value = JSON.parse(result.content.find((item) => item.type === "text").text);
  report.steps.push({
    name,
    images: result.content.filter((item) => item.type === "image").length,
    audio: result.content.filter((item) => item.type === "audio").length,
  });
  process.stdout.write(`${name}: OK\n`);
  for (const [index, item] of result.content.entries())
    if (item.type === "image")
      await writeFile(
        join(output, `${report.steps.length}-${name}-${index}.png`),
        Buffer.from(item.data, "base64"),
      );
  return value;
}

try {
  if (app)
    await until(async () => {
      if (launchError) throw launchError;
      if (app.exitCode !== null) throw new Error(`Aster exited with ${app.exitCode}: ${appLog}`);
      return fetch(`http://127.0.0.1:${port}/tools`, {
        headers: {},
      })
        .then((response) => response.ok)
        .catch(() => false);
    }, 60_000);
  await client.connect(transport, { timeout: 90_000 });
  report.adapterPid = transport.pid;
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "compare_reference"));
  const context = await call("get_editor_context");
  const workspace = await call("begin_edit_workspace", { baseRevision: context.projectRevision });
  let revision = workspace.workspaceRevision;
  const commands = async (values) => {
    const changed = await call("execute_commands", {
      workspaceId: workspace.workspaceId,
      workspaceRevision: revision,
      commands: values,
    });
    revision = changed.workspaceRevision;
  };
  await commands([
    {
      type: "addComposition",
      name: "Automation smoke",
      width: 320,
      height: 180,
      frameRateNumerator: 10,
      frameRateDenominator: 1,
      duration: 1,
      activate: true,
    },
    { type: "addLayer", kind: "solid", name: "Recreated block" },
  ]);
  const layers = await call("query_project", {
    workspaceId: workspace.workspaceId,
    kind: "layers",
  });
  const layerId = layers.items[0].id;
  await commands([
    { type: "setLayerTiming", layerId, inPoint: 0, outPoint: 1 },
    { type: "addKeyframe", layerId, path: "position.0", time: 0, value: 80 },
    { type: "addKeyframe", layerId, path: "position.0", time: 0.9, value: 240 },
  ]);
  const work = { workspaceId: workspace.workspaceId, workspaceRevision: revision };
  await call("evaluate_at_time", { ...work, time: 0.5 });
  const preview = await call("render_preview", { ...work, times: [0, 0.5], maxDimension: 1024 });
  assert.equal(preview.frames[0].width, 320);
  const cropped = await call("render_preview", {
    ...work,
    times: [0.5],
    maxDimension: 1024,
    crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    layerIds: [layerId],
  });
  assert.equal(cropped.frames[0].width, 160);
  const ffmpeg = join(dirname(binary), "resources", "bin", "ffmpeg.exe");
  const reference = join(output, "reference.mp4");
  const generated = spawnSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      reference,
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const probed = await call("probe_reference", { path: reference });
  assert(probed.streams.some((stream) => stream.codec_type === "audio"));
  const frames = await call("read_reference_frames", {
    path: reference,
    times: [0.15, 0.5],
    maxDimension: 1024,
  });
  assert.equal(frames.frames[0].actualTime, 0.2);
  await call("read_reference_audio", { path: reference, start: 0.1, duration: 0.5 });
  const comparison = await call("compare_reference", {
    ...work,
    path: reference,
    times: [0.15],
    maxDimension: 1024,
    crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  });
  assert.equal(comparison.frames[0].renderTime, 0.2);
  assert(Number.isFinite(comparison.frames[0].meanAbsoluteRgbError));
  await call("submit_workspace", { ...work, summary: "MCP reconstruction smoke test" });
  let live = await call("commit_workspace", work);
  const imported = await call("import_asset", {
    path: reference,
    baseRevision: live.projectRevision,
    time: 0,
  });
  live = { projectRevision: imported.projectRevision };
  const fonts = await call("check_fonts", { families: ["Arial", "AsterMissingFont012345"] });
  assert.equal(fonts.fonts[1].available, false);
  if (process.env.ASTER_SMOKE_FONT) {
    const inventory = await call("list_fonts", { source: "system", limit: 2 });
    assert(inventory.total > 0);
    assert(inventory.fonts.length <= 2);
    const family = "Aster Smoke Embedded";
    const importedFont = await call("import_font", {
      path: resolve(process.env.ASTER_SMOKE_FONT),
      family,
      baseRevision: live.projectRevision,
    });
    live = { projectRevision: importedFont.projectRevision };
    const available = await call("check_fonts", { families: [family] });
    assert.equal(available.fonts[0].method, "project-font");
    assert.equal(available.fonts[0].available, true);
    const metadata = await call("list_fonts", { source: "project" });
    assert.equal(metadata.fonts[0].family, family);
    assert.equal(metadata.fonts[0].dataUrl, undefined);
    const fontWork = await call("begin_edit_workspace", { baseRevision: live.projectRevision });
    const added = await call("execute_commands", {
      workspaceId: fontWork.workspaceId,
      workspaceRevision: fontWork.workspaceRevision,
      commands: [
        {
          type: "addComposition",
          name: "Font smoke",
          width: 1920,
          height: 1080,
          frameRateNumerator: 10,
          frameRateDenominator: 1,
          duration: 1,
          activate: true,
        },
        { type: "addLayer", kind: "text", name: "Embedded font", text: "Font" },
      ],
    });
    const layerId = added.changedObjectIds.at(-1);
    const before = await call("query_project", {
      workspaceId: fontWork.workspaceId,
      kind: "layers",
    });
    const original = before.items.find((layer) => layer.id === layerId).textStyle;
    const changed = await call("execute_commands", {
      workspaceId: fontWork.workspaceId,
      workspaceRevision: added.workspaceRevision,
      commands: [
        { type: "setLayerTiming", layerId, inPoint: 0, outPoint: 1 },
        {
          type: "setTextStyle",
          layerId,
          textStyle: { fontFamily: JSON.stringify(family), fontSize: 36, fontWeight: 400 },
        },
      ],
    });
    const after = await call("query_project", {
      workspaceId: fontWork.workspaceId,
      kind: "layers",
    });
    assert.deepEqual(after.items.find((layer) => layer.id === layerId).textStyle, {
      ...original,
      fontFamily: JSON.stringify(family),
      fontSize: 36,
      fontWeight: 400,
    });
    const finalWork = {
      workspaceId: fontWork.workspaceId,
      workspaceRevision: changed.workspaceRevision,
    };
    const fontPreview = await call("render_preview", {
      ...finalWork,
      times: [0, 0.5],
      maxDimension: 1024,
      layerIds: [layerId],
    });
    assert(fontPreview.frames.some((frame) => frame.measurements.maximumLuminance > 0.3));
    await call("submit_workspace", { ...finalWork, summary: "Verify embedded font rendering" });
    live = await call("commit_workspace", finalWork);
    const fontAudio = await call("import_asset", {
      path: reference,
      baseRevision: live.projectRevision,
      time: 0,
    });
    live = { projectRevision: fontAudio.projectRevision };
  }
  const projectPath = join(output, "project");
  await call("save_project", { path: projectPath, baseRevision: live.projectRevision });
  const saved = JSON.parse(await readFile(join(projectPath, "project.json"), "utf8"));
  assert(saved.sources.length > 0);
  if (process.env.ASTER_SMOKE_FONT) assert(saved.fonts[0].dataUrl.startsWith("data:font/"));
  const exportPath = join(output, "recreated.mp4");
  const queued = await call("export_render", {
    path: exportPath,
    baseRevision: live.projectRevision,
    outputKind: "mp4",
    includeAudio: true,
  });
  await until(async () => {
    const queue = await call("get_render_queue");
    const job = queue.items.find((item) => item.manifest.id === queued.jobId);
    if (job.status === "failed") throw new Error(JSON.stringify(job.error));
    return job.status === "completed";
  }, 90_000);
  const exported = await call("probe_reference", { path: exportPath });
  assert(exported.streams.some((stream) => stream.codec_type === "video"));
  assert(exported.streams.some((stream) => stream.codec_type === "audio"));
  report.status = "passed";
  process.stdout.write(`Packaged smoke passed: ${output}\n`);
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${report.error}\n`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  if (app?.pid && app.exitCode === null) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else app.kill();
  }
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(output, "application.log"), appLog);
}

async function until(check, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(500);
  }
  throw new Error("Smoke step timed out");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
