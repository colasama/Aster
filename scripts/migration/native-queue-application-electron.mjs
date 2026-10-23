import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

const root = process.cwd(),
  output = process.env.ASTER_QUEUE_APPLICATION_OUTPUT;
assert(output);
const report = {
  status: "failed",
  scope: "actual application native queue routing",
  launches: [],
  host_ipc: [],
  outputs: [],
};
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  register(channel, (...args) => {
    if (channel.startsWith("aster:render-host-")) report.host_ipc.push(channel);
    return handler(...args);
  });
const { NativeQueueHostFactory } = await import(
  pathToFileURL(join(root, "dist-electron/electron/native-queue-host.js"))
);
const launch = NativeQueueHostFactory.prototype.launch;
NativeQueueHostFactory.prototype.launch = function (item, lease, callback) {
  const observation = {
    jobId: item.manifest.id,
    lease,
    outputs: item.manifest.outputs,
    events: [],
  };
  report.launches.push(observation);
  return launch.call(this, item, lease, async (event) => {
    observation.events.push(event);
    return callback(event);
  });
};
await mkdir(join(output, "temp"), { recursive: true });
app.setAppPath(root);
app.commandLine.appendSwitch("user-data-dir", join(output, "profile"));
app.setPath("userData", join(output, "profile"));
app.setPath("temp", join(output, "temp"));
process.argv.push("--automation-background");
const server = createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
process.env.ASTER_NATIVE_QUEUE = "1";
process.env.ASTER_NATIVE_PREVIEW = "1";
process.env.ASTER_AUTOMATION_ENABLED = "1";
process.env.ASTER_AUTOMATION_PORT = String(port);
process.env.ASTER_FFMPEG_PATH = join(root, "build/ffmpeg/ffmpeg.exe");
process.env.ASTER_FFPROBE_PATH = join(root, "build/ffmpeg/ffprobe.exe");
await import(pathToFileURL(join(root, "dist-electron/electron/main.js")));

async function main() {
  try {
    await app.whenReady();
    const deadline = Date.now() + 60000;
    while (
      !(await fetch(`http://127.0.0.1:${port}/tools`)
        .then((r) => r.ok)
        .catch(() => false))
    ) {
      assert(Date.now() < deadline, "Application automation startup timed out");
      await delay(250);
    }
    const call = async (name, args = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "native-queue-application", name, arguments: args }),
      });
      const body = await response.json();
      if (body.error) throw Error(`${name}: ${JSON.stringify(body.errorDetails ?? body.error)}`);
      return body.result;
    };
    const context = await call("get_editor_context");
    const changed = await call("execute_aster_code", {
      baseRevision: context.projectRevision,
      commands: [
        {
          type: "addComposition",
          name: "Native queue application",
          width: 320,
          height: 180,
          frameRateNumerator: 30,
          frameRateDenominator: 1,
          duration: 0.4,
          activate: true,
        },
        { type: "addLayer", kind: "solid", name: "Native queue block" },
      ],
    });
    const committed = await call("commit_workspace", {
      workspaceId: changed.workspaceId,
      workspaceRevision: changed.workspaceRevision,
    });
    const source = join(output, "tone.wav");
    execFileSync(
      process.env.ASTER_FFMPEG_PATH,
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=1",
        source,
      ],
      { windowsHide: true },
    );
    const imported = await call("import_assets", {
      path: source,
      baseRevision: committed.projectRevision,
      time: 0,
    });
    const enqueue = async (kind, name, includeAudio) =>
      call("render", {
        action: "export",
        path: join(output, name),
        baseRevision: imported.projectRevision,
        outputKind: kind,
        includeAudio,
      });
    const jobs = [];
    for (const [kind, name, audio] of [
      ["still", "still.png", false],
      ["pngSequence", "sequence", false],
      ["mp4", "video.mp4", true],
    ]) {
      const queued = await enqueue(kind, name, audio);
      jobs.push({ id: queued.jobId, kind, path: join(output, name) });
    }
    for (const job of jobs) {
      const result = await call("render", { action: "wait", jobId: job.id, analyze: false });
      assert.equal(result.status, "completed", JSON.stringify(result));
      report.outputs.push({ ...job, result });
    }
    assert.equal(report.launches.length, 3);
    assert.equal(report.host_ipc.length, 0);
    assert(
      !BrowserWindow.getAllWindows().some((w) =>
        w.webContents.getURL().includes("render-host.html"),
      ),
    );
    const names = (await readdir(join(output, "sequence")))
      .filter((n) => n.endsWith(".png"))
      .sort();
    assert.equal(names.length, 12);
    const still = await hashFile(join(output, "still.png"));
    assert.equal(await hashFile(join(output, "sequence", names[0])), still);
    report.png = { sha256: still, sequence_frames: names.length, first_frame_exact: true };
    const probe = JSON.parse(
      execFileSync(
        process.env.ASTER_FFPROBE_PATH,
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", join(output, "video.mp4")],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    assert(probe.streams.some((s) => s.codec_type === "video" && Number(s.nb_frames) === 12));
    assert(probe.streams.some((s) => s.codec_type === "audio"));
    report.video = probe;
    const pending = await readdir(join(output, "temp", "aster-native-export"));
    assert.deepEqual(pending, []);
    report.native_jobs_cleaned = true;
    const queue = JSON.parse(await readFile(join(output, "profile", "render-queue.json")));
    report.persisted_jobs = queue.items.map((item) => ({
      id: item.manifest.id,
      status: item.status,
    }));
    assert.equal(report.persisted_jobs.length, 3);
    assert(report.persisted_jobs.every((item) => item.status === "completed"));
    report.status = "passed";
  } catch (error) {
    report.error = String(error.stack ?? error);
  } finally {
    await writeAtomicJson(join(output, "report.json"), report);
    console.log(JSON.stringify({ status: report.status, error: report.error }));
    app.quit();
    const timer = setTimeout(() => app.exit(report.status === "passed" ? 0 : 1), 10000);
    timer.unref();
  }
}
void main();
