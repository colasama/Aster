import { segmentTextLayoutUnits } from "../../../src/core/animation/text-animator-stack";
import {
  activateProjectFonts,
  prepareProjectFonts,
} from "../../../src/core/media/project-font-runtime";
import { loadProjectFromPath } from "../../../src/core/project/project-file";
import { mediaImportRuntime } from "../../../src/importers/media-import-runtime";
import type { FrameHeaderSlice } from "../../../src/renderer/frame-plan/types";
import { RetainedRasterProvider } from "../../../src/renderer/native-project/retained-raster-provider";
import type { RetainedRasterRequest } from "../../../src/renderer/native-project/retained-raster-types";
import { captureFontFingerprint } from "../capture-fonts";

interface Assignment {
  id: string;
  projectPath: string;
  samples: { index: number; time: number; header: FrameHeaderSlice }[];
}
interface Api {
  take(): Promise<Assignment | null>;
  ready(value: unknown): Promise<void>;
  prepare(value: unknown): Promise<{ requests: RetainedRasterRequest[] }>;
  frame(value: unknown): Promise<void>;
  done(): Promise<void>;
  fail(error: string): Promise<void>;
}
declare global {
  interface Window {
    asterNativeRaster: Api;
  }
}

async function run() {
  const api = window.asterNativeRaster;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("Native retained raster acquisition requires WebGPU");
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener("uncapturederror", (e) => errors.push(e.error.message));
  const initialFonts = await captureFontFingerprint();
  await api.ready({
    fonts: initialFonts,
    adapter: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
    },
    maximumDimension: device.limits.maxTextureDimension2D,
  });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  try {
    for (let assignment = await api.take(); assignment; assignment = await api.take()) {
      const { project } = await loadProjectFromPath(assignment.projectPath);
      await prepareProjectFonts(project);
      activateProjectFonts(project);
      const layouts = Object.fromEntries(
        project.compositions.map((c) => [
          c.id,
          Object.fromEntries(
            c.layers
              .filter((l) => l.kind === "text")
              .map((l) => [l.id, segmentTextLayoutUnits(l.text ?? l.name)]),
          ),
        ]),
      );
      const provider = new RetainedRasterProvider(device, layout, sampler);
      device.pushErrorScope("validation");
      try {
        for (const sample of assignment.samples) {
          const prepared = await api.prepare({
            caseId: assignment.id,
            index: sample.index,
            layouts,
            locale: new Intl.Collator().resolvedOptions().locale,
            maximumDimension: Math.min(8192, device.limits.maxTextureDimension2D),
          });
          const result = await provider.acquire(project, prepared.requests, sample.header);
          if (errors.length) throw new Error(errors.join("; "));
          await api.frame({ caseId: assignment.id, index: sample.index, ...result });
        }
      } finally {
        await device.queue.onSubmittedWorkDone();
        provider.destroy();
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
        mediaImportRuntime.clear();
        activateProjectFonts({ fonts: [] });
      }
      if (errors.length) throw new Error(errors.join("; "));
    }
    const finalFonts = await captureFontFingerprint();
    if (JSON.stringify(finalFonts) !== JSON.stringify(initialFonts))
      throw new Error("Fonts changed during native raster acquisition");
    await api.done();
  } finally {
    device.destroy();
  }
}
void run().catch((error) =>
  window.asterNativeRaster.fail(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  ),
);
