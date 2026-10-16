import assert from "node:assert/strict";
import { join } from "node:path";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Injected only by the opt-in profiler; keep private inputs and resource names out of telemetry. */
function installWaitCapture() {
  const started = performance.now(),
    totals = {},
    restores = [];
  const wrap = (owner, key, group) => {
    const original = owner?.[key];
    if (typeof original !== "function") return;
    const wrapped = function (...args) {
      const name = typeof group === "function" ? group(this) : group;
      totals[name] ??= { calls: 0, settled: 0, failed: 0, wall_ms: 0, max_ms: 0 };
      const entry = totals[name];
      entry.calls++;
      const before = performance.now();
      const settle = (failed) => {
        const elapsed = performance.now() - before;
        entry.settled++;
        entry.failed += Number(failed);
        entry.wall_ms += elapsed;
        entry.max_ms = Math.max(entry.max_ms, elapsed);
      };
      let result;
      try {
        result = Reflect.apply(original, this, args);
      } catch (error) {
        settle(true);
        throw error;
      }
      // Return the original promise. Observing its settlement must not reorder production awaits.
      void result.then(
        () => settle(false),
        () => settle(true),
      );
      return result;
    };
    owner[key] = wrapped;
    restores.push(() => {
      if (owner[key] === wrapped) owner[key] = original;
    });
  };
  wrap(globalThis.GPUBuffer?.prototype, "mapAsync", (buffer) =>
    buffer.label === "Retained media batch readback" ? "raster_map" : "other_map",
  );
  wrap(globalThis.GPUQueue?.prototype, "onSubmittedWorkDone", "queue_wait");
  wrap(globalThis.GPU?.prototype, "requestAdapter", "adapter");
  wrap(globalThis.GPUAdapter?.prototype, "requestDevice", "device");
  wrap(globalThis.GPUDevice?.prototype, "createRenderPipelineAsync", "render_pipeline");
  wrap(globalThis.GPUDevice?.prototype, "createComputePipelineAsync", "compute_pipeline");
  wrap(globalThis.GPUDevice?.prototype, "popErrorScope", "validation_scope");
  wrap(globalThis.GPUShaderModule?.prototype, "getCompilationInfo", "shader_info");
  wrap(globalThis.SubtleCrypto?.prototype, "digest", "digest");
  wrap(globalThis, "createImageBitmap", "bitmap");
  globalThis.__asterMigrationWaitCapture = () => {
    for (const restore of restores) restore();
    delete globalThis.__asterMigrationWaitCapture;
    return {
      elapsed_ms: performance.now() - started,
      totals,
      interpretation:
        "Summed asynchronous API wall times can overlap; these are diagnostic waits, not additive CPU time or accepted performance.",
    };
  };
  return { installed_hooks: restores.length };
}

/** Optional diagnostic sampling; no owner document or media bytes are recorded. */
export class RendererCpuCapture {
  sessions = [];
  constructor(output) {
    this.output = output;
  }
  watch(window) {
    const session = { contents: window.webContents };
    this.sessions.push(session);
    session.started = new Promise((done, reject) => {
      window.webContents.once("did-finish-load", () => {
        void (async () => {
          session.contents.debugger.attach("1.3");
          const installed = await session.contents.debugger.sendCommand("Runtime.evaluate", {
            expression: `(${installWaitCapture.toString()})()`,
            returnByValue: true,
          });
          assert(!installed.exceptionDetails, "Wait instrumentation failed to install");
          assert(installed.result.value.installed_hooks > 0);
          await session.contents.debugger.sendCommand("Profiler.enable");
          await session.contents.debugger.sendCommand("Profiler.setSamplingInterval", {
            interval: 1000,
          });
          await session.contents.debugger.sendCommand("Profiler.start");
        })().then(done, reject);
      });
      window.once("closed", () => reject(new Error("Profile window closed before load")));
    });
    void session.started.catch(() => undefined);
  }
  finish() {
    return Promise.all(
      this.sessions.map((session, index) => {
        session.finished ??= (async () => {
          await session.started;
          const { profile } = await session.contents.debugger.sendCommand("Profiler.stop");
          const waits = await session.contents.debugger.sendCommand("Runtime.evaluate", {
            expression: "globalThis.__asterMigrationWaitCapture()",
            returnByValue: true,
          });
          assert(!waits.exceptionDetails, "Wait instrumentation failed to finish");
          session.contents.debugger.detach();
          assert(profile.samples.length > 0);
          const path = join(this.output, `renderer-${index}.cpuprofile.json`);
          await writeAtomicJson(path, profile);
          const waitsPath = join(this.output, `renderer-${index}.waits.json`);
          await writeAtomicJson(waitsPath, waits.result.value);
          return {
            path,
            sha256: await hashFile(path),
            samples: profile.samples.length,
            waits: { path: waitsPath, sha256: await hashFile(waitsPath) },
          };
        })();
        return session.finished;
      }),
    );
  }
}
