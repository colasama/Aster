import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Real queue manager, durable store and native workers; no hidden TS render host. */
export async function validateNativeQueueHost(context, preparedRuntime, processReport) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const module = async (name) =>
    import(pathToFileURL(join(root, `dist-electron/electron/${name}.js`)));
  const { NativeQueueHostFactory } = await module("native-queue-host");
  const { RenderQueueManager } = await module("render-queue-manager");
  const { RenderQueueStore } = await module("render-queue-store");
  const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
  const fixture = corpus.cases.find((c) => c.id === "scene-audio-spectrum-bars");
  const runtime = {
    renderer: preparedRuntime.binary,
    executable: preparedRuntime.rasterProvider.executable,
    host: preparedRuntime.rasterProvider.arguments[0],
    bundle: preparedRuntime.rasterProvider.bundle,
    bridge: preparedRuntime.rasterProvider.bridge,
    ffmpeg: join(root, "build/ffmpeg/ffmpeg.exe"),
    ffprobe: join(root, "build/ffmpeg/ffprobe.exe"),
    compiler: join(root, "node_modules/electron/dist/dxcompiler.dll"),
  };
  const report = { status: "failed", source: preparedRuntime.source, cases: [] };
  const sessions = [];
  const create = async (name, holdAuthorization = false) => {
    const directory = join(output, name);
    await mkdir(directory);
    const jobs = join(directory, "jobs"),
      errors = [],
      states = [];
    let releases = 0,
      authorizations = 0,
      releaseAuthorization;
    const held = new Promise((resolve) => {
      releaseAuthorization = resolve;
    });
    const manifest = {
      ...processReport.manifest,
      id: `host-${name}`,
      outputs: processReport.manifest.outputs.map((item) => ({
        ...item,
        destination: join(directory, basename(item.destination)),
      })),
    };
    for (const item of manifest.outputs) {
      if (item.kind === "pngSequence") {
        await mkdir(item.destination);
        await writeFile(join(item.destination, "old.txt"), "old");
      } else await writeFile(item.destination, "old");
    }
    const store = new RenderQueueStore(directory);
    await store.initialize();
    const manager = new RenderQueueManager(
      store,
      (state) =>
        states.push(
          state.items.map((item) => ({
            id: item.manifest.id,
            status: item.status,
            progress: item.progress,
          })),
        ),
      undefined,
      (error) => errors.push(String(error)),
    );
    const factory = new NativeQueueHostFactory({
      temporaryRoot: jobs,
      runtime,
      onError: (error) => errors.push(String(error)),
      authorizeMedia: async () => {
        authorizations++;
        if (holdAuthorization && authorizations === 1) await held;
        return {
          nativeMediaPaths: [],
          dispose: () => {
            assert(
              !existsSync(jobs) || readdirSync(jobs).length === 0,
              "Media lease released before job cleanup",
            );
            releases++;
          },
        };
      },
      resolvePlugins: async (references) => ({
        packages: await Promise.all(
          references.map(async (reference) => {
            const directory = join(root, fixture.plugins[0]);
            const shaders = (await readdir(directory)).filter((f) => f.endsWith(".wgsl"));
            return {
              ...reference,
              manifestToml: await readFile(join(directory, "plugin.toml"), "utf8"),
              shaderSources: Object.fromEntries(
                await Promise.all(
                  shaders.map(async (f) => [f, await readFile(join(directory, f), "utf8")]),
                ),
              ),
            };
          }),
        ),
        unavailable: [],
      }),
    });
    const session = {
      directory,
      jobs,
      manifest,
      manager,
      factory,
      errors,
      states,
      releaseAuthorization,
      get releases() {
        return releases;
      },
      get authorizations() {
        return authorizations;
      },
    };
    sessions.push(session);
    await manager.startScheduler(factory);
    return session;
  };
  const wait = async (session, predicate, label) => {
    const end = Date.now() + 120000;
    while (!predicate()) {
      assert.equal(session.errors.length, 0, session.errors.join("\n"));
      const failed = session.manager.snapshot().items.find((item) => item.status === "failed");
      if (failed) throw new Error(`Native queue failed: ${JSON.stringify(failed.error)}`);
      if (Date.now() > end)
        throw new Error(
          `Queue ${label} timed out: ${JSON.stringify(session.manager.snapshot().items.map((i) => ({ status: i.status, error: i.error })))}`,
        );
      await delay(20);
    }
  };
  const item = (session) => session.manager.snapshot().items[0];
  const oldOutputs = async (session) => {
    for (const output of session.manifest.outputs)
      assert.equal(
        await readFile(
          output.kind === "pngSequence" ? join(output.destination, "old.txt") : output.destination,
          "utf8",
        ),
        "old",
      );
  };
  try {
    const complete = await create("complete");
    await complete.manager.enqueue(complete.manifest);
    await wait(complete, () => item(complete)?.status === "rendering", "start");
    await complete.manager.command({ type: "pause", jobId: complete.manifest.id });
    await wait(complete, () => item(complete).status === "paused", "pause");
    const paused = item(complete).progress;
    await delay(100);
    assert.deepEqual(item(complete).progress, paused);
    await complete.manager.command({ type: "resume", jobId: complete.manifest.id });
    await wait(
      complete,
      () => item(complete).status === "completed" && complete.manager.activeHostCount === 0,
      "completion",
    );
    assert.equal(complete.releases, 1);
    assert.deepEqual(await readdir(complete.jobs), []);
    for (const output of complete.manifest.outputs) {
      const baseline = processReport.cases.find((c) => c.id === output.id).receipt;
      if (output.kind === "still")
        assert.equal(await hashFile(output.destination), baseline.images[0].png_sha256);
      else if (output.kind === "pngSequence")
        for (const image of baseline.images) {
          const name = `frame_${String(complete.manifest.startFrame + image.index + 1).padStart(6, "0")}.png`;
          assert.equal(await hashFile(join(output.destination, name)), image.png_sha256);
        }
      else {
        const probe = await runStep(
          {
            id: `host-probe-${output.id}`,
            file: runtime.ffprobe,
            args: ["-v", "error", "-show_streams", "-of", "json", output.destination],
          },
          context,
        );
        assert.equal(probe.status, "passed");
        const log = await readFile(join(root, probe.log), "utf8");
        const streams = JSON.parse(log.slice(log.indexOf("\n") + 1)).streams;
        assert.equal(
          streams.some((s) => s.codec_type === "audio"),
          output.includeAudio,
        );
        const video = streams.find((s) => s.codec_type === "video");
        assert.equal(Number(video.nb_frames), 12);
        assert.equal(video.width, complete.manifest.width);
        assert.equal(video.height, complete.manifest.height);
      }
    }
    report.cases.push({
      id: "durable-mixed-queue-pause-resume",
      status: "passed",
      states: complete.states,
      lease_releases: complete.releases,
      images_exact: true,
    });
    context.print?.("native-queue-host: mixed outputs and pause/resume passed");
    const cancel = await create("cancel");
    await cancel.manager.enqueue(cancel.manifest);
    await wait(cancel, () => item(cancel)?.status === "rendering", "cancel start");
    await cancel.manager.command({ type: "pause", jobId: cancel.manifest.id });
    await wait(cancel, () => item(cancel).status === "paused", "cancel pause");
    await cancel.manager.command({ type: "cancel", jobId: cancel.manifest.id });
    await wait(cancel, () => cancel.manager.activeHostCount === 0, "cancel cleanup");
    assert.equal(item(cancel).status, "cancelled");
    assert.equal(cancel.releases, 1);
    await oldOutputs(cancel);
    assert.deepEqual(await readdir(cancel.jobs), []);
    report.cases.push({
      id: "cancel-paused-queue-preserves-destinations",
      status: "passed",
      states: cancel.states,
      lease_releases: cancel.releases,
    });
    const held = await create("authorization", true);
    await held.manager.enqueue(held.manifest);
    await wait(held, () => held.authorizations === 1, "authorization start");
    await held.manager.command({ type: "cancel", jobId: held.manifest.id });
    assert.equal(held.manager.activeHostCount, 1);
    assert.equal(held.releases, 0);
    const next = {
      ...held.manifest,
      id: "after-cancel",
      outputs: [{ ...held.manifest.outputs[0], destination: join(held.directory, "next.png") }],
    };
    await held.manager.enqueue(next);
    assert.equal(held.manager.snapshot().items[1].status, "queued");
    held.releaseAuthorization();
    await wait(
      held,
      () =>
        held.manager.snapshot().items[1].status === "completed" &&
        held.manager.activeHostCount === 0,
      "next job after cleanup",
    );
    assert.equal(held.releases, 2);
    await oldOutputs(held);
    assert.deepEqual(await readdir(held.jobs), []);
    assert.equal(
      await hashFile(next.outputs[0].destination),
      processReport.cases[0].receipt.images[0].png_sha256,
    );
    report.cases.push({
      id: "cancel-authorization-retains-slot-until-cleanup",
      status: "passed",
      states: held.states,
      lease_releases: held.releases,
    });
    for (const session of sessions) assert.deepEqual(session.errors, []);
    await preparedRuntime.assertUnchanged();
    report.status = "passed";
  } catch (error) {
    report.error = String(error?.stack ?? error);
  } finally {
    for (const session of sessions) {
      session.releaseAuthorization();
      await session.manager.shutdown();
      await session.factory.dispose();
    }
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
