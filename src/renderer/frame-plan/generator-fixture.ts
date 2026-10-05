import { buildAudioAnalysisFrame } from "../../core/audio/audio-analysis-frame";
import { createGeneratorLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import {
  createSceneGeneratorInstance,
  sceneGeneratorDefinitionFromManifest,
} from "../../core/scene/scene-generator-registry";
import {
  bundledParticleDefinition,
  bundledParticleManifest,
} from "../scene/bundled-particle-generator";
import { SceneGeneratorHost } from "../scene/scene-generator-host";
import type { SceneGeneratorPlan } from "../scene/scene-generator-plan";
import { SceneGeneratorPlanner } from "../scene/scene-generator-plan";
import { encodeFramePlan } from "./codec";
import { buildGeneratorSlice } from "./generator-plan";
import { buildFrameHeader } from "./root-post-plan";

export function generatorFixtures() {
  return ["billboard", "mesh-clone", "audio"].map((id, index) => {
    const project = createBlankProject(),
      composition = project.compositions[0];
    composition.id = `generator-${id}`;
    const manifest = structuredClone(bundledParticleManifest);
    manifest.plugin.id = "org.example.fixture.particles";
    manifest.capabilities.push("audio_analysis");
    const definition =
      id === "audio"
        ? sceneGeneratorDefinitionFromManifest(manifest, bundledParticleDefinition.shaderSources)
        : bundledParticleDefinition;
    const instance = createSceneGeneratorInstance(definition);
    instance.parameters.count = id === "mesh-clone" ? 1_000_000 : 1500;
    instance.parameters.renderMode = id === "mesh-clone" ? "mesh" : "billboard";
    const layer = createGeneratorLayerForComposition(composition, instance);
    layer.id = `generator-${id}`;
    layer.timeOffset = 2;
    layer.timeStretch = 2;
    layer.cloner = {
      distribution: { kind: "grid", count: [2, 1, 1], spacing: [120, 0, 0] },
      effectors: [],
    };
    composition.layers = [layer];
    const scenes = flattenSceneLayers(composition, project, 6);
    const scene = scenes[index % 2];
    const planner = new SceneGeneratorPlanner();
    const audio = buildAudioAnalysisFrame(undefined, 6);
    audio[100] = -0;
    audio[101] = 0.375;
    planner.beginFrame(() => audio);
    const generator = planner.prepare({
      scene,
      composition,
      definition,
      width: 64,
      height: 48,
      memoryBudgetMb: 32,
      storageByteLimit: 512 * 1024 * 1024,
      dispatchWorkgroupLimit: 65535,
    });
    if (id === "audio") {
      generator.instanceId = "audio-\ud800";
      generator.selectionId = "selection-\udc00";
    }
    const header = buildFrameHeader({
      snapshot: { snapshotScope: "generator-fixture", projectRevision: 1 },
      compositionId: composition.id,
      time: 6,
      frameRate: composition.frameRate,
      target: { width: 64, height: 48 },
      renderTarget: { width: 64, height: 48 },
      antiAliasing: "off",
    });
    const plan = buildGeneratorSlice(header, generator);
    return {
      id: `generator-${id}`,
      generator,
      plan,
      bytes: encodeFramePlan(plan.metadata, plan.blobs),
    };
  });
}

export function recordGeneratorExecution(plan: SceneGeneratorPlan) {
  const previousStage = Reflect.get(globalThis, "GPUShaderStage"),
    previousUsage = Reflect.get(globalThis, "GPUBufferUsage");
  Object.assign(globalThis, {
    GPUShaderStage: { COMPUTE: 1, VERTEX: 2, FRAGMENT: 4 },
    GPUBufferUsage: { STORAGE: 1, COPY_DST: 2, INDIRECT: 4, UNIFORM: 8 },
  });
  const uploads: { label: string; bytes: number[] }[] = [],
    dispatches: number[][] = [],
    draws: string[] = [];
  try {
    const device = {
      limits: {
        maxStorageBufferBindingSize: 512 * 1024 * 1024,
        maxBufferSize: 512 * 1024 * 1024,
        maxComputeWorkgroupsPerDimension: 65535,
        maxColorAttachments: 4,
        maxColorAttachmentBytesPerSample: 16,
      },
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createShaderModule: () => ({}),
      createComputePipeline: () => ({}),
      createRenderPipeline: (d: GPURenderPipelineDescriptor) => ({ label: d.vertex.entryPoint }),
      createBuffer: (d: GPUBufferDescriptor) => ({ label: d.label, size: d.size, destroy() {} }),
      createBindGroup: () => ({}),
      queue: {
        writeBuffer: (buffer: { label: string }, _offset: number, data: ArrayBufferView) =>
          uploads.push({
            label: buffer.label,
            bytes: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
          }),
      },
    } as unknown as GPUDevice;
    const host = new SceneGeneratorHost(device, "rgba16float");
    host.beginFrame();
    const generator = host.preparePlan(plan);
    host.encodeCompute(
      {
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups: (...d: number[]) => dispatches.push(d),
      } as unknown as GPUComputePassEncoder,
      generator,
    );
    host.draw(
      {
        setPipeline: (p: GPURenderPipeline) => draws.push(p.label),
        setBindGroup() {},
        drawIndirect: (b: GPUBuffer) => draws.push(b.label),
      } as unknown as GPURenderPassEncoder,
      generator,
    );
    host.destroy();
    return { uploads, dispatches, draws };
  } finally {
    if (previousStage === undefined) Reflect.deleteProperty(globalThis, "GPUShaderStage");
    else Reflect.set(globalThis, "GPUShaderStage", previousStage);
    if (previousUsage === undefined) Reflect.deleteProperty(globalThis, "GPUBufferUsage");
    else Reflect.set(globalThis, "GPUBufferUsage", previousUsage);
  }
}
