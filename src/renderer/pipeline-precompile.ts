import type { SceneGeneratorDefinition } from "../core/scene-generator-registry";
import type { BlendMode } from "../core/types";
import { gpuBlendState } from "./blend-state";
import { depthEffectsShader } from "./depth-effects";
import {
  IMAGE_VERTEX_BUFFERS,
  SHADOW_VERTEX_BUFFERS,
  SHAPE_VERTEX_BUFFERS,
} from "./scene-pipelines";
import {
  imageShader,
  postProcessShader,
  shadowShader,
  shapeShader,
  textureCompositeShader,
} from "./shaders";

const SCENE_FORMAT: GPUTextureFormat = "rgba16float";

export interface PipelinePrecompileReport {
  count: number;
  durationMs: number;
}

export async function precompileGpuPipelines(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  bundledGenerators: readonly SceneGeneratorDefinition[] = [],
): Promise<PipelinePrecompileReport> {
  const started = performance.now();
  const module = (label: string, code: string) => device.createShaderModule({ label, code });
  const shape = module("Async precompile · shape", shapeShader);
  const image = module("Async precompile · image", imageShader);
  const shadow = module("Async precompile · shadow", shadowShader);
  const post = module("Async precompile · post process", postProcessShader);
  const depthEffects = module("Async precompile · depth effects", depthEffectsShader);
  const composite = module("Async precompile · texture composite", textureCompositeShader);
  const generatorModules = new Map<string, GPUShaderModule>();
  const generatorModule = (definition: SceneGeneratorDefinition, path: string) => {
    const key = `${definition.runtimeKey}:${path}`;
    const existing = generatorModules.get(key);
    if (existing) return existing;
    const source = definition.shaderSources[path];
    if (!source) throw new Error(`${definition.pluginName} is missing runtime shader ${path}`);
    const created = module(`Async precompile · ${definition.pluginName} · ${path}`, source);
    generatorModules.set(key, created);
    return created;
  };
  const generatorTasks = bundledGenerators.flatMap((definition) => [
    ...definition.graph.render_variants.flatMap((variant) =>
      generatorBlendModes(variant.blend).map((blendMode) =>
        device.createRenderPipelineAsync({
          label: `Async precompile · ${definition.pluginName} · ${variant.id} · ${blendMode}`,
          layout: "auto",
          vertex: {
            module: generatorModule(definition, variant.shader),
            entryPoint: variant.vertex_entry,
          },
          fragment: {
            module: generatorModule(definition, variant.shader),
            entryPoint: variant.fragment_entry,
            targets: [{ format: SCENE_FORMAT, blend: gpuBlendState(blendMode) }],
          },
          primitive: { topology: "triangle-list", cullMode: variant.cull },
          depthStencil: generatorDepthState(variant.depth),
        }),
      ),
    ),
    ...definition.graph.compute_passes.map((pass) =>
      device.createComputePipelineAsync({
        label: `Async precompile · ${definition.pluginName} · ${pass.id}`,
        layout: "auto",
        compute: {
          module: generatorModule(definition, pass.shader),
          entryPoint: pass.entry_point,
        },
      }),
    ),
  ]);
  const tasks = [
    device.createRenderPipelineAsync({
      label: "Async precompile · shape pipeline",
      layout: "auto",
      vertex: { module: shape, entryPoint: "vertex_main", buffers: SHAPE_VERTEX_BUFFERS },
      fragment: { module: shape, entryPoint: "fragment_main", targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    }),
    device.createRenderPipelineAsync({
      label: "Async precompile · image pipeline",
      layout: "auto",
      vertex: { module: image, entryPoint: "vertex_main", buffers: IMAGE_VERTEX_BUFFERS },
      fragment: { module: image, entryPoint: "fragment_main", targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    }),
    device.createRenderPipelineAsync({
      label: "Async precompile · shadow pipeline",
      layout: "auto",
      vertex: { module: shadow, entryPoint: "vertex_main", buffers: SHADOW_VERTEX_BUFFERS },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    }),
    ...generatorTasks,
    device.createRenderPipelineAsync(fullscreenDescriptor("post process", post, canvasFormat)),
    device.createRenderPipelineAsync(
      fullscreenDescriptor("depth effects", depthEffects, canvasFormat),
    ),
    device.createRenderPipelineAsync(
      fullscreenDescriptor("texture composite", composite, SCENE_FORMAT),
    ),
  ];
  await Promise.all(tasks);
  return { count: tasks.length, durationMs: performance.now() - started };
}

function generatorBlendModes(blend: BlendMode | "layer"): readonly BlendMode[] {
  return blend === "layer" ? ["normal", "add", "multiply", "screen", "overlay"] : [blend];
}

function generatorDepthState(depth: "none" | "read" | "read_write"): GPUDepthStencilState {
  return {
    format: "depth24plus",
    depthWriteEnabled: depth === "read_write",
    depthCompare: depth === "none" ? "always" : "less-equal",
  };
}

function fullscreenDescriptor(
  label: string,
  module: GPUShaderModule,
  format: GPUTextureFormat,
): GPURenderPipelineDescriptor {
  return {
    label: `Async precompile · ${label} pipeline`,
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main" },
    fragment: { module, entryPoint: "fragment_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  };
}
