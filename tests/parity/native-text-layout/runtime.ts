import { evaluateLayerSourceTime } from "../../../src/core/animation/layer-time";
import {
  activateProjectFonts,
  prepareProjectFonts,
} from "../../../src/core/media/project-font-runtime";
import { validateProjectDocument } from "../../../src/core/project/validation/document";
import { flattenSceneLayers } from "../../../src/core/scene/scene-evaluation";
import type { Composition, Project } from "../../../src/core/types";
import { planTextMotionBlurFrame } from "../../../src/renderer/text/text-motion-blur-plan";
import {
  rasterizeTextLayer,
  transformedTextRasterScale,
} from "../../../src/renderer/text/text-rasterizer";
import { captureFontFingerprint } from "../capture-fonts";
import { TextGpuReference } from "./gpu-reference";
import { observeTextRaster } from "./observer";

interface LayoutSample {
  composition: string;
  time: number;
  scale: number;
  scope: string;
}
interface LayoutAssignment {
  composition: string;
  frames: number[];
  size: { width: number; height: number };
}
let project: Project;
let projectFonts = "";
const gpuReference = new TextGpuReference();

async function digest(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function prepare(raw: unknown, assignment: LayoutAssignment) {
  project = validateProjectDocument(raw);
  await prepareProjectFonts(project);
  activateProjectFonts(project);
  projectFonts = await digest(new TextEncoder().encode(JSON.stringify(project.fonts ?? [])).buffer);
  const root = project.compositions.find((c) => c.id === assignment.composition);
  if (!root) throw new Error("Text capture composition missing");
  const rate = root.frameRate.numerator / root.frameRate.denominator;
  const scale = Math.max(assignment.size.width / root.width, assignment.size.height / root.height);
  const samples: LayoutSample[] = assignment.frames.map((frame) => ({
    composition: root.id,
    time: frame / rate,
    scale,
    scope: "declared-corpus",
  }));
  let seed = 0xa57e17b;
  for (let index = 0; index < 64; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    samples.push({
      composition: root.id,
      time: (seed / 0x1_0000_0000) * root.duration,
      scale,
      scope: "random-corpus",
    });
  }
  const authored = [];
  for (const composition of project.compositions)
    for (const layer of composition.layers) {
      if (layer.kind !== "text") continue;
      authored.push({
        composition: composition.id,
        layer: layer.id,
        visible: layer.visible,
        inPoint: layer.inPoint,
        outPoint: layer.outPoint,
      });
      for (const time of [layer.inPoint, (layer.inPoint + layer.outPoint) / 2]) {
        if (!Number.isFinite(time) || time < 0 || time >= composition.duration) continue;
        samples.push({
          composition: composition.id,
          time,
          scale: 1,
          scope: "authored-composition",
        });
      }
    }
  const unique = [...new Map(samples.map((sample) => [JSON.stringify(sample), sample])).values()];
  if (unique.length > 10_000) throw new Error("Text capture sample budget exceeded");
  return { samples: unique, authored, project_fonts_sha256: projectFonts };
}

async function capture(sample: LayoutSample, extended: boolean) {
  const root = project.compositions.find((c) => c.id === sample.composition);
  if (!root) throw new Error("Text sample composition missing");
  const requests: {
    composition: string;
    layer: Composition["layers"][number];
    instance: string;
    localTime: number;
    frameRate: number;
    scale: number;
    temporal: boolean;
    ancestry: string[];
  }[] = [];
  const visit = (composition: Composition, time: number, scale: number, ancestry: string[]) => {
    if (ancestry.includes(composition.id) || ancestry.length > 32)
      throw new Error("Text sample composition cycle/depth");
    const path = [...ancestry, composition.id];
    const scenes = flattenSceneLayers(composition, project, time);
    const exposure = planTextMotionBlurFrame({
      composition,
      project,
      frameTime: time,
      sceneLayers: scenes,
      resolutionScale: scale,
    });
    for (const scene of exposure.renderSceneLayers) {
      if (scene.precompositionSurface)
        visit(
          scene.precompositionSurface.composition,
          scene.precompositionSurface.time,
          scale,
          path,
        );
      if (scene.layer.kind !== "text") continue;
      const temporal = exposure.plans.get(scene.resourceInstanceId);
      const times = temporal?.samples.map((s) => s.localTime) ?? [
        evaluateLayerSourceTime(scene.layer, scene.localTime),
      ];
      for (const localTime of times)
        requests.push({
          composition: scene.sourceComposition.id,
          layer: scene.layer,
          instance: scene.resourceInstanceId,
          localTime,
          frameRate: composition.frameRate.numerator / composition.frameRate.denominator,
          scale: transformedTextRasterScale(scale, scene.transform.scale),
          temporal: Boolean(temporal),
          ancestry: path,
        });
      if (requests.length > 4096) throw new Error("Text observation request budget exceeded");
    }
  };
  visit(root, sample.time, sample.scale, []);
  const records = [];
  for (const [index, request] of requests.entries()) {
    const plain = rasterizeTextLayer(request.layer, 4096, request.localTime, request.scale);
    const observed = observeTextRaster(request.layer, request.localTime, request.scale, 4096);
    if (
      plain.width !== observed.raster.width ||
      plain.height !== observed.raster.height ||
      JSON.stringify(plain.bounds) !== JSON.stringify(observed.raster.bounds)
    )
      throw new Error("Observation changed text bounds");
    const originalPixels = plain.canvas
      .getContext("2d")
      ?.getImageData(0, 0, plain.width, plain.height);
    const observedPixels = observed.raster.canvas
      .getContext("2d")
      ?.getImageData(0, 0, plain.width, plain.height);
    if (!originalPixels || !observedPixels) throw new Error("Text pixels unavailable");
    const originalHash = await digest(originalPixels.data.buffer as ArrayBuffer);
    const observedHash = await digest(observedPixels.data.buffer as ArrayBuffer);
    if (originalHash !== observedHash)
      throw new Error("Observation changed production text pixels");
    if (extended && observed.observations.draws.some((draw) => draw.clusters === null))
      throw new Error("Extended text metrics unavailable");
    records.push({
      index,
      composition: request.composition,
      layer: request.layer.id,
      instance: request.instance,
      ancestry: request.ancestry,
      local_time: request.localTime,
      temporal: request.temporal,
      width: plain.width,
      height: plain.height,
      bounds: plain.bounds,
      rgba_sha256: originalHash,
      gpu_rgba_sha256: await gpuReference.capture(plain.canvas, originalHash),
      retained_reference: request.temporal
        ? null
        : await gpuReference.retained(
            request.layer,
            request.localTime,
            request.frameRate,
            request.scale,
          ),
      observation_neutral: true,
      project_fonts_sha256: projectFonts,
      ...observed.observations,
      ...(extended ? { png: observed.raster.canvas.toDataURL("image/png").split(",")[1] } : {}),
    });
    plain.canvas.width =
      plain.canvas.height =
      observed.raster.canvas.width =
      observed.raster.canvas.height =
        1;
  }
  return { sample, records };
}

Object.assign(window, {
  prepareTextLayout: prepare,
  captureTextLayout: capture,
  textLayoutHost: async () => ({
    fonts: await captureFontFingerprint(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    segmentation_locale: new Intl.Segmenter().resolvedOptions().locale,
    agent: navigator.userAgent,
    extended:
      typeof (
        document.createElement("canvas").getContext("2d")?.measureText("A") as TextMetrics & {
          getTextClusters?: unknown;
        }
      )?.getTextClusters === "function",
  }),
});
