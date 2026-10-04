import { postProcessShader } from "./shaders";

export function createPostPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const module = device.createShaderModule({
    label: "HDR fused effects and display shader",
    code: postProcessShader,
  });
  return device.createRenderPipeline({
    label: "HDR post-process and sRGB output",
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main" },
    fragment: {
      module,
      entryPoint: "fragment_main",
      constants: { root_zero_operations: 1 },
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });
}
