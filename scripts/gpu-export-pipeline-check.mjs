// Import run() from a WebGPU browser served by unbundled Vite. See docs/BENCHMARKS.md.
import {
  runRenderHostFrameLoop,
  validateRenderHostAssignment,
} from "/src/components/render-host/render-host-session.ts";
import { createLayerForComposition } from "/src/core/layers/layer-factory.ts";
import { createBlankProject } from "/src/core/project/project.ts";
import { frameTimeAtIndex } from "/src/core/rendering/render-export.ts";
import { staticValue } from "/src/core/types.ts";
import { createImageSequenceImport } from "/src/importers/advanced-import.ts";
import { detectImageSequence } from "/src/importers/image-sequence.ts";
import { mediaImportRuntime } from "/src/importers/media-import-runtime.ts";
import {
  createBeautyFrameRequest,
  createViewportBeautyFrameBackend,
  ProductionBeautyFramePipeline,
} from "/src/renderer/compositing/beauty-frame.ts";
import { summarizeSamples } from "/src/renderer/diagnostics/gpu-benchmark.ts";
import { WebGpuRenderer } from "/src/renderer/webgpu-renderer.ts";

export async function run({
  width = 1920,
  height = 1080,
  frameCount = 300,
  maxInFlightFrames = 3,
  frameLoop = runRenderHostFrameLoop,
  output = async () => undefined,
  outputKind = "readback-only",
  prepareComposition,
  Renderer = WebGpuRenderer,
  createBackend = createViewportBeautyFrameBackend,
} = {}) {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.width = width;
  composition.height = height;
  composition.duration = Math.max(1, frameCount / 30);
  composition.workArea = { start: 0, end: composition.duration };
  composition.frameRate = { numerator: 30, denominator: 1 };
  composition.layers = Array.from({ length: 20 }, (_, index) => {
    const layer = createLayerForComposition("shape", composition);
    layer.color = [(index % 3) / 3, (index % 5) / 5, (index % 7) / 7, 0.7];
    layer.size = [width / 3, height / 3];
    layer.transform.anchor = [width / 6, height / 6, 0].map(staticValue);
    layer.transform.position[0] = { mode: "static", value: (width * (index % 5)) / 5 };
    layer.transform.position[1] = { mode: "static", value: (height * (index % 4)) / 4 };
    layer.transform.rotation[2] = {
      mode: "animated",
      keyframes: [
        { id: `${index}-start`, time: 0, value: index * 7, interpolation: "linear" },
        {
          id: `${index}-end`,
          time: composition.duration,
          value: index * 7 + 360,
          interpolation: "linear",
        },
      ],
    };
    return layer;
  });
  prepareComposition?.(composition, project);
  const assignment = validateRenderHostAssignment({
    jobId: "export-pipeline-check",
    leaseId: "benchmark",
    manifest: {
      id: "export-pipeline-check",
      compositionId: composition.id,
      compositionName: composition.name,
      projectRevision: 0,
      projectSnapshot: JSON.stringify(project),
      width,
      height,
      frameRate: composition.frameRate,
      startFrame: 0,
      endFrameExclusive: frameCount,
      priority: 1,
      createdAt: "2026-09-22T00:00:00.000Z",
      outputs: [
        {
          id: "mp4",
          kind: "mp4",
          destination: "export-pipeline-check.mp4",
          codec: "h264",
          bitrateMbps: 20,
          includeAudio: false,
        },
      ],
    },
  });
  const canvas = document.createElement("canvas");
  const renderer = await Renderer.create(canvas);
  const pipeline = new ProductionBeautyFramePipeline(createBackend(renderer, canvas));
  const capture = (frame) =>
    pipeline.readback(
      createBeautyFrameRequest({
        project: assignment.project,
        composition: assignment.composition,
        time: frameTimeAtIndex(frame, composition.frameRate),
        width,
        height,
      }),
    );
  try {
    // Compare changing frame addresses byte-for-byte, outside the throughput interval.
    const addresses = [0, Math.floor(frameCount / 3), Math.floor((frameCount * 2) / 3)];
    const reference = [];
    for (const frame of addresses) reference.push(await capture(frame));
    const overlapped = await Promise.all(addresses.map(capture));
    for (let frame = 0; frame < addresses.length; frame += 1) {
      const expected = new Uint8Array(reference[frame].pixels);
      const actual = new Uint8Array(overlapped[frame].pixels);
      if (expected.some((value, index) => value !== actual[index]))
        throw new Error(`Concurrent frame ${addresses[frame]} differs from serial capture`);
    }
    for (let frame = 0; frame < 10; frame += 1) await capture(frame % frameCount);
    const intervals = [];
    let startedAt = 0;
    let lastProgressAt = 0;
    let completedAt = 0;
    await frameLoop({
      assignment,
      pixelFormat: pipeline.pixelFormat,
      maxInFlightFrames: Math.min(maxInFlightFrames, pipeline.maxConcurrentReadbacks),
      requestedControl: () => undefined,
      renderFrame: (frame) => capture(frame),
      encodePng: async () => {
        throw new Error("Unexpected PNG output in MP4 benchmark");
      },
      output,
      report: async (report) => {
        const now = performance.now();
        if (report.type === "prepared") startedAt = lastProgressAt = now;
        if (report.type === "progress") {
          intervals.push(now - lastProgressAt);
          lastProgressAt = now;
        }
        if (report.type === "completed") completedAt = now;
      },
    });
    return {
      width,
      height,
      frameCount,
      layers: composition.layers.length,
      warmupFrames: 10,
      outputKind,
      adapter: renderer.diagnostics,
      pixelParity: "exact",
      parityFrames: addresses,
      elapsedMs: completedAt - startedAt,
      framesPerSecond: (frameCount * 1000) / (completedAt - startedAt),
      frameCompletionIntervalMs: summarizeSamples(intervals),
      frameCompletionIntervalsMs: intervals,
    };
  } finally {
    renderer.dispose();
  }
}

/** Cold decodes must keep their own media generation when three captures start together. */
export async function checkImageSequence() {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.width = composition.height = 32;
  const sourceCanvas = new OffscreenCanvas(16, 16);
  const context = sourceCanvas.getContext("2d");
  const files = [];
  for (const [index, color] of ["#ff0000", "#00ff00", "#0000ff"].entries()) {
    context.fillStyle = color;
    context.fillRect(0, 0, 16, 16);
    const blob = await sourceCanvas.convertToBlob({ type: "image/png" });
    files.push({
      name: `frame_${index + 1}.png`,
      size: blob.size,
      type: blob.type,
      lastModified: 1,
      url: URL.createObjectURL(blob),
    });
  }
  const imported = createImageSequenceImport(
    {
      selection: detectImageSequence(files),
      dispose: () => {
        for (const file of files) URL.revokeObjectURL(file.url);
      },
    },
    [16, 16],
    { frameRate: { numerator: 30, denominator: 1 }, missingFramePolicy: "error", loop: false },
    composition,
    0,
  );
  project.sources = imported.sources;
  composition.layers = imported.layers;
  const captures = [];
  try {
    for (const concurrent of [false, true]) {
      const canvas = document.createElement("canvas");
      const renderer = await WebGpuRenderer.create(canvas);
      const pipeline = new ProductionBeautyFramePipeline(
        createViewportBeautyFrameBackend(renderer, canvas),
      );
      const capture = (frame) =>
        pipeline.readback(
          createBeautyFrameRequest({
            project,
            composition,
            time: frame / 30,
            width: 32,
            height: 32,
          }),
        );
      try {
        const frames = [];
        if (concurrent) frames.push(...(await Promise.all([0, 1, 2].map(capture))));
        else for (const frame of [0, 1, 2]) frames.push(await capture(frame));
        captures.push(frames);
      } finally {
        renderer.dispose();
      }
    }
    for (const frame of [0, 1, 2]) {
      const reference = new Uint8Array(captures[0][frame].pixels);
      const actual = new Uint8Array(captures[1][frame].pixels);
      if (actual.some((value, index) => value !== reference[index]))
        throw new Error(`Image sequence frame ${frame} changed during concurrent capture`);
      const channel = captures[1][frame].pixelFormat === "bgra" ? 2 - frame : frame;
      if (actual[(16 * 32 + 16) * 4 + channel] < 250)
        throw new Error(`Image sequence frame ${frame} captured the wrong source generation`);
    }
    return { frameCount: 3, coldDecodes: true, pixelParity: "exact" };
  } finally {
    for (const source of imported.sources) mediaImportRuntime.remove(source.id);
  }
}
