import { captureFragmentShader } from "./transparent-fragments";

interface CapturablePipeline {
  descriptor: GPURenderPipelineDescriptor;
  code: string;
  groups: number;
  captured?: GPURenderPipeline;
}
const pipelines = new WeakMap<GPURenderPipeline, CapturablePipeline>();

export function createCapturablePipeline(
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor,
  code: string,
  groups = 1,
): GPURenderPipeline {
  const pipeline = device.createRenderPipeline(descriptor);
  pipelines.set(pipeline, { descriptor, code, groups });
  return pipeline;
}

export function transparencyPipeline(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  captureLayout: GPUBindGroupLayout,
  emptyLayout: GPUBindGroupLayout,
): GPURenderPipeline {
  const source = pipelines.get(pipeline);
  if (!source) throw new Error("Unsupported pipeline in an exact transparency group");
  if (source.captured) return source.captured;
  const module = device.createShaderModule({
    label: "Exact transparent material",
    code: captureFragmentShader(source.code),
  });
  source.captured = device.createRenderPipeline({
    ...source.descriptor,
    label: "Exact transparent fragment capture",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [0, 1, 2]
        .map((index) => (index < source.groups ? pipeline.getBindGroupLayout(index) : emptyLayout))
        .concat(captureLayout),
    }),
    vertex: { ...source.descriptor.vertex, module },
    fragment: {
      module,
      entryPoint: "capture_fragment",
      targets: [{ format: "rgba16float", writeMask: 0 }],
    },
    depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "always" },
  });
  return source.captured;
}
