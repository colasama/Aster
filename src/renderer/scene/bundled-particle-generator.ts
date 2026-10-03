import type {
  PluginManifest,
  PluginParameter,
  SceneGeneratorGraph,
} from "../../core/plugins/plugins";
import {
  BUILTIN_PARTICLE_NODE_TYPE,
  BUILTIN_PARTICLE_PLUGIN_ID,
} from "../../core/scene/bundled-particle";
import { SCENE_GENERATOR_API_VERSION } from "../../core/scene/scene-generator";
import { sceneGeneratorDefinitionFromManifest } from "../../core/scene/scene-generator-registry";
import { sharedShaders } from "../gpu/shared-shader-catalog";

const COMPUTE_SHADER = "particle-compute.wgsl";
const RENDER_SHADER = "particle-render.wgsl";

export const bundledParticleParameters: PluginParameter[] = [
  {
    type: "choice",
    name: "renderMode",
    label: "Render mode",
    default: "billboard",
    choices: ["billboard", "streak", "mesh"],
  },
  {
    type: "choice",
    name: "meshPrimitive",
    label: "Mesh primitive",
    default: "cube",
    choices: ["cube"],
  },
  { type: "number", name: "count", label: "Count", default: 100_000, min: 1, max: 1_000_000 },
  { type: "number", name: "seed", label: "Seed", default: 13_337, min: 0, max: 16_777_215 },
  { type: "number", name: "lifetime", label: "Lifetime", default: 4, min: 0.05, max: 3_600 },
  {
    type: "choice",
    name: "emitterShape",
    label: "Emitter shape",
    default: "point",
    choices: ["point", "box", "sphere", "ring", "line"],
  },
  {
    type: "vector",
    name: "emitterPosition",
    label: "Emitter position",
    default: [0, 0, 0],
    min: -100_000,
    max: 100_000,
  },
  {
    type: "vector",
    name: "emitterSize",
    label: "Emitter size",
    default: [0, 0, 0],
    min: 0,
    max: 100_000,
  },
  { type: "number", name: "emitterSpread", label: "Emitter spread", default: 12, min: 0, max: 180 },
  {
    type: "vector",
    name: "velocity",
    label: "Velocity",
    default: [0, -0.26, 0],
    min: -10_000,
    max: 10_000,
  },
  {
    type: "vector",
    name: "gravity",
    label: "Gravity",
    default: [0, 0.08, 0],
    min: -10_000,
    max: 10_000,
  },
  { type: "number", name: "drag", label: "Drag", default: 0.04, min: 0, max: 10 },
  { type: "number", name: "turbulence", label: "Turbulence", default: 0.06, min: 0, max: 10 },
  {
    type: "number",
    name: "turbulenceScale",
    label: "Turbulence scale",
    default: 3,
    min: 0.01,
    max: 100,
  },
  {
    type: "vector",
    name: "startColor",
    label: "Start color",
    default: [1, 0.48, 0.12],
    min: 0,
    max: 16,
  },
  {
    type: "vector",
    name: "endColor",
    label: "End color",
    default: [0.12, 0.35, 1],
    min: 0,
    max: 16,
  },
  { type: "number", name: "startOpacity", label: "Start opacity", default: 0.9, min: 0, max: 1 },
  { type: "number", name: "endOpacity", label: "End opacity", default: 0, min: 0, max: 1 },
  { type: "number", name: "startSize", label: "Start size", default: 16, min: 0.01, max: 256 },
  { type: "number", name: "endSize", label: "End size", default: 2, min: 0.01, max: 256 },
  {
    type: "number",
    name: "startRotation",
    label: "Start rotation",
    default: 0,
    min: -36_000,
    max: 36_000,
  },
  {
    type: "number",
    name: "endRotation",
    label: "End rotation",
    default: 180,
    min: -36_000,
    max: 36_000,
  },
  { type: "number", name: "streakLength", label: "Streak length", default: 1, min: 0.01, max: 5 },
];

export const bundledParticleGraph: SceneGeneratorGraph = {
  api_version: 1,
  node_type: BUILTIN_PARTICLE_NODE_TYPE,
  capacity_parameter: "count",
  max_instances: 1_000_000,
  instance_stride: 48,
  render_parameter: "renderMode",
  compute_passes: [
    {
      id: "simulate",
      shader: COMPUTE_SHADER,
      entry_point: "compute_main",
      workgroup_size: [256, 1, 1],
      phase: "simulation",
    },
  ],
  render_variants: [
    renderVariant("billboard", 6, "none", "none"),
    renderVariant("streak", 6, "none", "none"),
    renderVariant("mesh", 36, "read_write", "back", "layer"),
  ],
};

function renderVariant(
  id: "billboard" | "streak" | "mesh",
  vertexCount: number,
  depth: "none" | "read_write",
  cull: "none" | "back",
  blend: "add" | "layer" = "layer",
): SceneGeneratorGraph["render_variants"][number] {
  return {
    id,
    shader: RENDER_SHADER,
    vertex_entry: `${id}_vertex`,
    fragment_entry: `${id}_fragment`,
    vertex_count: vertexCount,
    selector_value: id,
    blend,
    depth,
    cull,
    auxiliary: {
      shader: RENDER_SHADER,
      vertex_entry: `${id}_vertex`,
      fragment_entry: `${id}_auxiliary`,
    },
  };
}

export const particleGeneratorComputeShader = sharedShaders.source("particle-compute");

export const particleGeneratorRenderShader = sharedShaders.source("particle-render");

export const bundledParticleManifest: PluginManifest = {
  plugin: {
    id: BUILTIN_PARTICLE_PLUGIN_ID,
    name: "Particles",
    version: "1.0.0",
    api_version: SCENE_GENERATOR_API_VERSION,
    shader: COMPUTE_SHADER,
    kind: "scene_generator",
  },
  capabilities: ["gpu_compute", "gpu_render"],
  parameters: bundledParticleParameters,
  scene_generator: bundledParticleGraph,
};

export const bundledParticleDefinition = sceneGeneratorDefinitionFromManifest(
  bundledParticleManifest,
  {
    [COMPUTE_SHADER]: particleGeneratorComputeShader,
    [RENDER_SHADER]: particleGeneratorRenderShader,
  },
);
