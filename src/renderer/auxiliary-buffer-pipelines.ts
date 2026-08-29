import { auxiliarySurfaceShader } from "./auxiliary-surface-shader";
import { AUXILIARY_BUFFER_DESCRIPTORS, AUXILIARY_BUFFER_KINDS } from "./render-buffers";
import { SHAPE_VERTEX_BUFFERS } from "./scene-pipelines";

export interface AuxiliaryBufferPipelines {
  shape: GPURenderPipeline;
  media: GPURenderPipeline;
  transparentShape: GPURenderPipeline;
  transparentMedia: GPURenderPipeline;
  peelShape: GPURenderPipeline;
  peelMedia: GPURenderPipeline;
  frontColorShape: GPURenderPipeline;
  frontColorMedia: GPURenderPipeline;
  peelBindGroupLayout: GPUBindGroupLayout;
}

export function createAuxiliaryBufferPipelines(
  device: GPUDevice,
  imageBindGroupLayout: GPUBindGroupLayout,
): AuxiliaryBufferPipelines {
  const module = device.createShaderModule({
    label: "Auxiliary MRT surface shader",
    code: auxiliarySurfaceShader,
  });
  const targets = AUXILIARY_BUFFER_KINDS.map((kind) => ({
    format: AUXILIARY_BUFFER_DESCRIPTORS[kind].format,
  }));
  const vertexBuffers: GPUVertexBufferLayout[] = [
    ...SHAPE_VERTEX_BUFFERS,
    {
      arrayStride: 8,
      stepMode: "instance",
      attributes: [
        { shaderLocation: 12, offset: 0, format: "uint32" },
        { shaderLocation: 13, offset: 4, format: "uint32" },
      ],
    },
    {
      arrayStride: 8,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 14, offset: 0, format: "float32x2" }],
    },
  ];
  const base: Omit<GPURenderPipelineDescriptor, "fragment" | "layout"> = {
    vertex: { module, entryPoint: "surface_vertex", buffers: vertexBuffers },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  };
  const shape = device.createRenderPipeline({
    ...base,
    label: "Auxiliary MRT geometry pipeline",
    layout: "auto",
    fragment: { module, entryPoint: "surface_fragment", targets },
  });
  const media = device.createRenderPipeline({
    ...base,
    label: "Auxiliary MRT alpha-tested media pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [imageBindGroupLayout] }),
    fragment: { module, entryPoint: "media_fragment", targets },
  });
  const transparentTarget: GPUColorTargetState = {
    format: "rgba16float",
    blend: {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    },
  };
  const transparentShape = device.createRenderPipeline({
    label: "Auxiliary transparency-weighted world-position pipeline",
    layout: "auto",
    vertex: { module, entryPoint: "surface_vertex", buffers: vertexBuffers },
    fragment: { module, entryPoint: "transparent_surface_fragment", targets: [transparentTarget] },
    primitive: { topology: "triangle-list", cullMode: "none" },
  });
  const transparentMedia = device.createRenderPipeline({
    label: "Auxiliary media transparency-weighted world-position pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [imageBindGroupLayout] }),
    vertex: { module, entryPoint: "surface_vertex", buffers: vertexBuffers },
    fragment: { module, entryPoint: "transparent_media_fragment", targets: [transparentTarget] },
    primitive: { topology: "triangle-list", cullMode: "none" },
  });
  const peelBindGroupLayout = device.createBindGroupLayout({
    label: "Auxiliary front-depth peel layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "depth" },
      },
    ],
  });
  const emptyLayout = device.createBindGroupLayout({ entries: [] });
  const colorTarget: GPUColorTargetState = { format: "rgba16float" };
  const frontColorDepthStencil: GPUDepthStencilState = {
    format: "depth24plus",
    depthWriteEnabled: false,
    depthCompare: "equal",
  };
  const frontColorShape = device.createRenderPipeline({
    label: "Auxiliary front layer color pipeline",
    layout: "auto",
    vertex: { module, entryPoint: "surface_vertex", buffers: vertexBuffers },
    fragment: { module, entryPoint: "front_color_surface_fragment", targets: [colorTarget] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: frontColorDepthStencil,
  });
  const frontColorMedia = device.createRenderPipeline({
    label: "Auxiliary front media layer color pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [imageBindGroupLayout] }),
    vertex: { module, entryPoint: "surface_vertex", buffers: vertexBuffers },
    fragment: { module, entryPoint: "front_color_media_fragment", targets: [colorTarget] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: frontColorDepthStencil,
  });
  const peelDepthStencil: GPUDepthStencilState = {
    format: "depth24plus",
    depthWriteEnabled: true,
    depthCompare: "less-equal",
  };
  const peelShape = device.createRenderPipeline({
    label: "Auxiliary second transparent layer peel pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [emptyLayout, peelBindGroupLayout] }),
    vertex: { module, entryPoint: "surface_vertex", buffers: vertexBuffers },
    fragment: {
      module,
      entryPoint: "peeled_surface_fragment",
      targets: [colorTarget, colorTarget],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: peelDepthStencil,
  });
  const peelMedia = device.createRenderPipeline({
    label: "Auxiliary second media layer peel pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [imageBindGroupLayout, peelBindGroupLayout],
    }),
    vertex: { module, entryPoint: "surface_vertex", buffers: vertexBuffers },
    fragment: { module, entryPoint: "peeled_media_fragment", targets: [colorTarget, colorTarget] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: peelDepthStencil,
  });
  return {
    shape,
    media,
    transparentShape,
    transparentMedia,
    peelShape,
    peelMedia,
    frontColorShape,
    frontColorMedia,
    peelBindGroupLayout,
  };
}
