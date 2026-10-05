import { executeFinalOutput } from "../../../src/renderer/compositing/execute-final-output";
import { MotionBlurRenderer } from "../../../src/renderer/compositing/motion-blur-renderer";
import { DepthEffectsRenderer } from "../../../src/renderer/effects/depth-effects";
import { buildPostProcessUniforms } from "../../../src/renderer/effects/post-process";
import { SurfacePostEffectsRenderer } from "../../../src/renderer/effects/surface-post-effects";
import { decodeFramePlan, encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import {
  buildFinalOutputPlan,
  readFinalOutputPlan,
} from "../../../src/renderer/frame-plan/final-output-plan";
import { buildMotionReconstructionPlan } from "../../../src/renderer/frame-plan/motion-reconstruction-plan";
import {
  buildPostEffectPlan,
  readPostEffectPlan,
} from "../../../src/renderer/frame-plan/post-effect-plan";
import type { FramePlanSliceData } from "../../../src/renderer/frame-plan/types";
import {
  isDepthEffectVisualization,
  isSurfaceEffectVisualization,
} from "../../../src/renderer/gpu/render-buffers";
import { observableDevice } from "../auxiliary-replay/draw";
import { outputResources, readOutput } from "./draw";
import { type Attachment, depthSettings, motionSettings, outputFixtures } from "./fixtures";
import { LegacyDepthEffectsRenderer } from "./legacy-depth";
import { LegacyMotionBlurRenderer } from "./legacy-motion";
import { legacyOutput } from "./legacy-output";
import { LegacySurfacePostEffectsRenderer } from "./legacy-surface";

type ReplayCase = {
  id: string;
  plans: Record<string, number[]>;
  attachments: Attachment[];
  uniforms: number[];
};
const pack = (p: FramePlanSliceData) => Array.from(encodeFramePlan(p.metadata, p.blobs));
const unpack = (b: number[]) => decodeFramePlan(new Uint8Array(b));
async function devicePair() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  return { device, adapter };
}
function setSources(
  depth: DepthEffectsRenderer | LegacyDepthEffectsRenderer,
  surface: SurfacePostEffectsRenderer | LegacySurfacePostEffectsRenderer,
  r: ReturnType<typeof outputResources>,
  scene: GPUTexture,
  motion: boolean,
) {
  const { width, height } = scene;
  const args = [
    width,
    height,
    scene,
    r.texture("worldPosition"),
    r.textures.get("transparentWorldPosition"),
    r.textures.get("peeledWorldPosition"),
    r.textures.get("frontLayerColor"),
    r.textures.get("peeledLayerColor"),
  ] as const;
  if (depth instanceof DepthEffectsRenderer)
    depth.setSources(...args, motion ? "motion_blur" : "scene");
  else depth.setSources(...args);
  surface.setSources(
    width,
    height,
    r.texture("scene"),
    r.texture("objectId"),
    r.texture("motionVector"),
  );
}
async function capture() {
  const { device, adapter } = await devicePair(),
    cases = [];
  try {
    for (const c of outputFixtures()) {
      const { width, height } = c.header.render_target,
        uniforms = new Uint8Array(buildPostProcessUniforms(width, height, 1.25).buffer);
      const r = outputResources(device, c.header, c.attachments, uniforms),
        motion = new LegacyMotionBlurRenderer(observableDevice(device)),
        depth = new LegacyDepthEffectsRenderer(device, "rgba8unorm"),
        surface = new LegacySurfacePostEffectsRenderer(device, "rgba8unorm");
      const depthProducer = new DepthEffectsRenderer(device, "rgba8unorm"),
        surfaceProducer = new SurfacePostEffectsRenderer(device, "rgba8unorm");
      motion.setSources(
        width,
        height,
        r.texture("scene"),
        r.texture("motionVector"),
        r.texture("objectId"),
      );
      const scene = c.motion ? (motion.outputTexture as GPUTexture) : r.texture("scene");
      setSources(depth, surface, r, scene, c.motion);
      setSources(depthProducer, surfaceProducer, r, scene, c.motion);
      for (const d of [depth, depthProducer])
        d.setSettings({ ...depthSettings, transparencyTier: c.tier });
      for (const s of [surface, surfaceProducer]) {
        s.setSelection(17);
        s.setMotionShutterScale(1.5);
      }
      const plans: Record<string, number[]> = {
        output: pack(
          buildFinalOutputPlan(c.header, {
            visualization: c.mode,
            auxiliaryValid: true,
            beautyDepthOfField: false,
            motionBlurValid: c.motion,
            motionBlurBindingAvailable: true,
          }),
        ),
        motion: pack(
          buildMotionReconstructionPlan(c.header, {
            requested: c.motion,
            resourcesAvailable: true,
            settings: motionSettings,
            shutter: { openTime: 1.24, duration: 0.02 },
            compositionWidth: width,
          }),
        ),
      };
      if (isDepthEffectVisualization(c.mode))
        plans.effect = pack(depthProducer.buildPlan(c.header, c.mode));
      if (isSurfaceEffectVisualization(c.mode))
        plans.effect = pack(surfaceProducer.buildPlan(c.header, c.mode));
      const encoder = device.createCommandEncoder();
      if (c.motion) motion.encode(encoder, motionSettings);
      legacyOutput(
        encoder,
        r.target.createView(),
        r.aa,
        {
          postPipeline: r.pipeline,
          postBindGroup: r.binding(r.texture("scene")),
          motionBlurPostBindGroup: r.binding(motion.outputTexture as GPUTexture),
          depthEffects: depth,
          surfacePostEffects: surface,
          bufferVisualizer: r.visualizer,
          gpuProfiler: r.profiler,
        },
        c.mode,
        c.aa,
        c.motion,
      );
      device.queue.submit([encoder.finish()]);
      cases.push({
        id: c.id,
        plans,
        attachments: c.attachments,
        uniforms: Array.from(uniforms),
        reference: await readOutput(device, r.target),
      });
      motion.destroy();
      depth.destroy();
      surface.destroy();
      depthProducer.destroy();
      surfaceProducer.destroy();
      r.destroy();
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return {
      cases,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
      },
    };
  } finally {
    device.destroy();
  }
}
async function run(device: GPUDevice, item: ReplayCase, mutation?: string) {
  const plans = Object.fromEntries(Object.entries(item.plans).map(([k, v]) => [k, unpack(v)]));
  const header = plans.output.metadata.header;
  const route = readFinalOutputPlan(plans.output).route;
  if (mutation === "route")
    plans.output = buildFinalOutputPlan(header, {
      visualization: route.kind === "visualizer" && route.mode === "alpha" ? "luminance" : "alpha",
      auxiliaryValid: true,
      beautyDepthOfField: false,
      motionBlurValid: false,
      motionBlurBindingAvailable: false,
    });
  if (mutation === "effect") {
    const e = readPostEffectPlan(plans.effect),
      view = new DataView(e.uniforms.buffer);
    if (e.slice.effect.kind === "depth")
      view.setFloat32(e.slice.effect.mode === "depthFog" ? 28 : 68, 0, true);
    else if (e.slice.effect.mode === "selectionIsolation") view.setUint32(12, 29, true);
    else view.setFloat32(16, 0, true);
    plans.effect = buildPostEffectPlan(header, e.slice.effect, true, e.uniforms);
  }
  if (mutation === "motion") {
    const bytes = plans.motion.blobs[0];
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(16, 0, true);
  }
  const r = outputResources(device, header, item.attachments, new Uint8Array(item.uniforms)),
    motion = new MotionBlurRenderer(observableDevice(device)),
    depth = new DepthEffectsRenderer(device, "rgba8unorm"),
    surface = new SurfacePostEffectsRenderer(device, "rgba8unorm");
  try {
    motion.setSources(
      header.render_target.width,
      header.render_target.height,
      r.texture("scene"),
      r.texture("motionVector"),
      r.texture("objectId"),
    );
    const encoder = device.createCommandEncoder(),
      motionValid = motion.encodePlan(encoder, plans.motion);
    setSources(
      depth,
      surface,
      r,
      motionValid ? (motion.outputTexture as GPUTexture) : r.texture("scene"),
      motionValid,
    );
    // Poison live settings: supplied plan bytes must be the only execution controls.
    depth.setSettings({ fogDensity: 99, aperture: 0, focusDistance: 999 });
    surface.setSelection(999);
    surface.setMotionShutterScale(0);
    executeFinalOutput({
      plan: plans.output,
      postEffectPlan: mutation === "route" ? undefined : plans.effect,
      encoder,
      output: r.target.createView(),
      antiAliasing: r.aa,
      resources: {
        postPipeline: r.pipeline,
        postBindGroup: r.binding(r.texture("scene")),
        motionBlurPostBindGroup: r.binding(motion.outputTexture as GPUTexture),
        depthEffects: depth,
        surfacePostEffects: surface,
        bufferVisualizer: r.visualizer,
        gpuProfiler: r.profiler,
      },
    });
    device.queue.submit([encoder.finish()]);
    return await readOutput(device, r.target);
  } finally {
    motion.destroy();
    depth.destroy();
    surface.destroy();
    r.destroy();
  }
}
async function replay(cases: ReplayCase[]) {
  const { device } = await devicePair(),
    results = [];
  try {
    for (const item of cases) {
      const output = unpack(item.plans.output),
        motion = unpack(item.plans.motion),
        mutations = [];
      const bytes = await run(device, item);
      for (const id of [
        "route",
        ...(item.plans.effect ? ["effect"] : []),
        ...(motion.metadata.slices[0].kind === "motion_reconstruction" &&
        motion.metadata.slices[0].status === "ready" &&
        readFinalOutputPlan(output).route.kind === "beauty"
          ? ["motion"]
          : []),
      ])
        mutations.push({ id, bytes: await run(device, item, id) });
      results.push({ id: item.id, bytes, mutations });
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return results;
  } finally {
    device.destroy();
  }
}
Object.assign(window, { captureOutput: capture, replayOutput: replay });
