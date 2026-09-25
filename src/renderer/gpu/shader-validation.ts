import { layerCompositeShader } from "../compositing/layer-composite";
import { motionBlurShader } from "../compositing/motion-blur-renderer";
import { antiAliasingShader } from "../effects/anti-aliasing";
import { blurDownsampleShader, brightpassDownsampleShader } from "../effects/blur-pyramid";
import { depthEffectsShader } from "../effects/depth-effects";
import { surfacePostEffectsShader } from "../effects/surface-post-effects";
import {
  particleGeneratorComputeShader,
  particleGeneratorRenderShader,
} from "../scene/bundled-particle-generator";
import { textMotionBlurRasterShader } from "../text/text-motion-blur-raster-cache";
import { auxiliarySurfaceShader } from "./auxiliary-buffer-renderer";
import {
  imageShader,
  materialShapeShader,
  postProcessShader,
  shadowShader,
  shapeShader,
} from "./shaders";

export async function validateShaderSources(device: GPUDevice): Promise<void> {
  const sources = [
    ["output anti-aliasing", antiAliasingShader],
    ["shape", shapeShader],
    ["normal-mapped HDR environment", materialShapeShader],
    ["image", imageShader],
    ["scene generator ABI particle compute", particleGeneratorComputeShader],
    ["scene generator ABI particle render", particleGeneratorRenderShader],
    ["shadow", shadowShader],
    ["post process", postProcessShader],
    ["blur pyramid downsample", blurDownsampleShader],
    ["brightpass downsample", brightpassDownsampleShader],
    ["layer blend options", layerCompositeShader],
    ["auxiliary surface MRT", auxiliarySurfaceShader],
    ["depth effects", depthEffectsShader],
    ["time-addressed vector motion blur", motionBlurShader],
    ["texture-local temporal text motion blur", textMotionBlurRasterShader],
    ["object isolation and vector motion blur", surfacePostEffectsShader],
  ] as const;
  for (const [label, code] of sources) {
    const module = device.createShaderModule({ label: `Validate ${label}`, code });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length === 0) continue;
    const details = errors
      .slice(0, 8)
      .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
      .join("\n");
    throw new Error(`WebGPU ${label} shader compilation failed:\n${details}`);
  }
}
