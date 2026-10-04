import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedAudioDecodeCache } from "../../src/core/audio/audio-decode-cache";
import type { PluginStatus } from "../../src/core/plugins/plugins";
import { mediaImportRuntime } from "../../src/importers/media-import-runtime";
import {
  assertCaptureMedia,
  assertCapturePlugins,
  captureComposition,
  prepareCaptureAudio,
} from "./capture-resources";
import { caseFor, fixture } from "./generators/base";
import { attachAudioFixture } from "./generators/media";

afterEach(() => {
  mediaImportRuntime.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reference capture resources", () => {
  it("accepts appended neighboring frames without sorting and rejects stale composition addresses", () => {
    const { project } = fixture("address");
    const generated = caseFor("address", project, []);
    const assignment = {
      case: generated.case,
      frames: [30, 29, 31],
      projectPath: "D:/project.json",
      caseHash: "d".repeat(64),
    };
    expect(captureComposition(assignment, generated.project).id).toBe(generated.case.composition);
    expect(assignment.frames).toEqual([30, 29, 31]);
    expect(() => captureComposition({ ...assignment, frames: [60] }, generated.project)).toThrow(
      "outside the composition",
    );
    expect(() => captureComposition(assignment, project)).toThrow("Missing capture composition");
  });

  it("rejects a missing payload recorded by hydration even if a locator exists", () => {
    const scene = fixture("missing-media");
    const source = attachAudioFixture(scene.project);
    source.runtimeUrl = "blob:existing";
    const layer = scene.layer("audio");
    layer.sourceId = source.id;
    scene.composition.layers = [layer];
    mediaImportRuntime.reportError(source.id, new Error("payload unavailable"));
    expect(() => assertCaptureMedia(scene.project, scene.composition)).toThrow(
      "payload unavailable",
    );
    mediaImportRuntime.clearError(source.id);
    expect(() => assertCaptureMedia(scene.project, scene.composition)).not.toThrow();
    delete source.runtimeUrl;
    expect(() => assertCaptureMedia(scene.project, scene.composition)).toThrow("hydrated locator");
  });

  it("does not accept a successful plugin RPC with no activated shader runtime", () => {
    const id = "org.aster.example.audio-spectrum";
    const status: PluginStatus = {
      native: true,
      safeMode: false,
      directory: "isolated/plugins",
      disabled: [],
      report: { plugins: [], failures: [], shader_sources: {} },
      hotReload: {
        enabled: false,
        suspendedBySafeMode: false,
        pending: false,
        revision: 0,
        successfulReloads: 0,
        rejectedReloads: 0,
        diagnostics: [],
      },
    };
    expect(() => assertCapturePlugins([id], status, new Set())).toThrow("validated shader runtime");
    status.report.shader_sources = { [id]: { "compute.wgsl": "validated shader" } };
    expect(() => assertCapturePlugins([id], status, new Set([id]))).not.toThrow();
    status.disabled = [id];
    expect(() => assertCapturePlugins([id], status, new Set([id]))).toThrow(
      "validated shader runtime",
    );
  });

  it("propagates audio decode failure before production analysis can substitute silence", async () => {
    const scene = fixture("audio-decode");
    const source = attachAudioFixture(scene.project);
    const audio = scene.layer("audio");
    audio.sourceId = source.id;
    scene.composition.layers = [audio];
    vi.stubGlobal("OfflineAudioContext", class {});
    const decode = vi
      .spyOn(sharedAudioDecodeCache, "decode")
      .mockRejectedValue(new Error("bad WAV"));
    await expect(prepareCaptureAudio(scene.project, scene.composition)).rejects.toThrow("bad WAV");
    expect(decode).toHaveBeenCalledWith(expect.anything(), source);
  });
});
