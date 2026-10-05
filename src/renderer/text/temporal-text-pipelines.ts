import { sharedShaders } from "../gpu/shared-shader-catalog";

/** Shared accumulation and resolve pipelines for live and supplied temporal samples. */
export class TemporalTextPipelines {
  readonly sampleLayout: GPUBindGroupLayout;
  readonly resolveLayout: GPUBindGroupLayout;
  readonly accumulatePipeline: GPURenderPipeline;
  readonly resolvePipeline: GPURenderPipeline;
  constructor(device: GPUDevice) {
    this.sampleLayout = device.createBindGroupLayout({
      label: "Temporal text sample layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.resolveLayout = device.createBindGroupLayout({
      label: "Temporal text resolve layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
      ],
    });
    const module = device.createShaderModule({
      label: "Temporal text premultiplied accumulation shader",
      code: sharedShaders.source("text-motion-blur-raster"),
    });
    this.accumulatePipeline = device.createRenderPipeline({
      label: "Temporal text linear HDR accumulation",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.sampleLayout] }),
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "accumulate_fragment",
        targets: [
          {
            format: "rgba16float",
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
    this.resolvePipeline = device.createRenderPipeline({
      label: "Temporal text straight-alpha sRGB resolve",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.resolveLayout] }),
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "resolve_fragment",
        targets: [{ format: "rgba8unorm-srgb" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }
}
