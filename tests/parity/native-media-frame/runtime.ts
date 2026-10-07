import { createLayerForComposition } from "../../../src/core/layers/layer-factory";
import { type Composition, createTransform, type FootageSource } from "../../../src/core/types";
import { FrameBundleRenderer } from "../../../src/renderer/compositing/frame-bundle-renderer";
import { encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import type { FrameBundle } from "../../../src/renderer/frame-plan/frame-bundle-plan";
import { readFrameBundle } from "../../../src/renderer/frame-plan/frame-bundle-read";
import { normalizeRawFrameRgba } from "../../../src/renderer/gpu/raw-frame-png";
import { WebGpuRenderer } from "../../../src/renderer/webgpu-renderer";
import { fixture } from "../temporal-text/runtime";

interface Asset {
  data: string;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
  duration?: number;
}

function nativeInputs(input: FrameBundle) {
  const bundle = structuredClone(input);
  const envelope = bundle.plan.metadata.slices[0];
  if (envelope.kind !== "frame_bundle") throw Error("Frame envelope absent");
  const rasterFrames = new Set(
    bundle.resources
      .filter(
        (r) => r.message.kind === "media_frame" && r.message.descriptor.sample.kind === "raster",
      )
      .map((r) => r.message.hash),
  );
  const removed = new Set(
    envelope.media_pixels.filter((p) => !rasterFrames.has(p.frame)).map((p) => p.pixels),
  );
  envelope.media_pixels = envelope.media_pixels.filter((p) => rasterFrames.has(p.frame));
  for (const pixel of envelope.media_pixels) removed.delete(pixel.pixels);
  bundle.plan.metadata.resources = bundle.plan.metadata.resources.filter((h) => !removed.has(h));
  bundle.resources = bundle.resources.filter((r) => !removed.has(r.message.hash));
  const counts = bundle.plan.blobs[0];
  new DataView(counts.buffer, counts.byteOffset, counts.byteLength).setUint32(
    16,
    envelope.media_pixels.length,
    true,
  );
  readFrameBundle(bundle);
  return bundle;
}

/** Independent-device TS replay freezes mixed native-file and temporal-raster expectations. */
export async function captureMixedMedia(assets: Record<string, Asset>) {
  const results = [];
  for (const mode of ["root", "recursive"] as const) {
    const { project, composition, layer: text } = fixture("full");
    composition.width = 320;
    composition.height = 180;
    composition.background = [0, 0, 0, 0];
    text.transform = createTransform([145, 40, 0], [128, 40, 0]);
    if (text.textStyle) text.textStyle.fontSize = 40;
    for (const [index, name] of ["pattern.png", "barcode-24000-1001.mp4"].entries()) {
      const asset = assets[name],
        video = name.endsWith("mp4");
      const shared = {
        id: name,
        name,
        mimeType: asset.mimeType,
        contentIdentity: `sha256:${asset.sha256}`,
        runtimeUrl: `data:${asset.mimeType};base64,${asset.data}`,
        width: asset.width,
        height: asset.height,
        interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
      };
      const source: FootageSource = video
        ? { ...shared, kind: "video", duration: asset.duration ?? 3.003 }
        : { ...shared, kind: "still" };
      project.sources.push(source);
      const layer = createLayerForComposition(video ? "video" : "image", composition);
      layer.sourceId = name;
      layer.size = [96, 64];
      layer.transform = createTransform([70 + index * 175, 125, 0], [48, 32, 0]);
      composition.layers.push(layer);
    }
    let target: Composition = composition;
    if (mode === "recursive") {
      for (let depth = 0; depth < 2; depth++) {
        const parent = structuredClone(composition);
        parent.id = crypto.randomUUID();
        const layer = createLayerForComposition("precomposition", parent);
        layer.sourceCompositionId = target.id;
        layer.size = [320, 180];
        layer.transform = createTransform([160, 90, 0], [160, 90, 0]);
        layer.effects = [
          {
            id: `blur-${depth}`,
            type: "gaussian-blur",
            name: "Blur",
            enabled: true,
            parameters: { radius: 1 },
          },
        ];
        parent.layers = [layer];
        project.compositions.push(parent);
        target = parent;
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    document.body.append(canvas);
    console.log(`capture: ${mode} creating production device`);
    const renderer = await WebGpuRenderer.create(canvas);
    const replay = await FrameBundleRenderer.create();
    console.log(`capture: ${mode} devices ready`);
    try {
      let previous: Uint8ClampedArray | undefined;
      renderer.configureBeautyTarget(320, 180, "off");
      for (const [index, time] of [0.5, 1, 0.5].entries()) {
        console.log(`capture: ${mode}-${index} render`);
        const raw = await renderer.renderRawFrame(
          target,
          time,
          { snapshotScope: `mixed-media:${mode}`, projectRevision: 1 },
          project,
          true,
          undefined,
          true,
        );
        if (!raw.bundle) throw Error("Mixed frame capture absent");
        const rgba = normalizeRawFrameRgba(raw, 320, 180);
        if (rgba.filter((value, index) => index % 4 === 3 && value > 8).length < 1000)
          throw Error("Mixed reference has insufficient visible coverage");
        if (previous && rgba.filter((value, index) => value !== previous?.[index]).length < 100)
          throw Error("Mixed reference time did not change visible pixels");
        previous = rgba;
        const repeated = await replay.render(raw.bundle);
        if (rgba.some((byte, i) => byte !== repeated[i]))
          throw Error("Independent TS replay differs");
        const decoded = readFrameBundle(raw.bundle);
        const kinds = new Set<string>(decoded.mediaFrames.map((f) => f.descriptor.sample.kind));
        if (!["image", "video", "raster"].every((kind) => kinds.has(kind)))
          throw Error("Mixed media kinds absent");
        if (replay.temporalExecution.passes === 0) throw Error("Temporal raster execution absent");
        if (mode === "recursive" && decoded.plans.precompositions.length < 2)
          throw Error("Recursive surfaces absent");
        const hybrid = nativeInputs(raw.bundle);
        results.push({
          id: `${mode}-${index}`,
          mode,
          time,
          width: 320,
          height: 180,
          independent_device_exact: true,
          adapter: {
            device: renderer.diagnostics.adapter,
            description: renderer.diagnostics.description,
          },
          surfaces: decoded.plans.precompositions.length,
          temporal: replay.temporalExecution,
          plan: Array.from(encodeFramePlan(hybrid.plan.metadata, hybrid.plan.blobs)),
          replay: Array.from(encodeFramePlan(raw.bundle.plan.metadata, raw.bundle.plan.blobs)),
          resources: raw.bundle.resources.map((r) => ({
            message: r.message,
            bytes: Array.from(r.bytes),
          })),
          rgba: Array.from(rgba),
        });
      }
    } finally {
      await renderer.complete();
      renderer.dispose();
      replay.destroy();
      canvas.remove();
    }
  }
  return results;
}
