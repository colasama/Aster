import { buildAudioAnalysisFrame } from "../../../src/core/audio/audio-analysis-frame";
import { createGeneratorLayerForComposition } from "../../../src/core/layers/layer-factory";
import type { PluginStatus } from "../../../src/core/plugins/plugins";
import { createBlankProject } from "../../../src/core/project/project";
import { flattenSceneLayers } from "../../../src/core/scene/scene-evaluation";
import {
  createSceneGeneratorInstance,
  getSceneGeneratorDefinitions,
  synchronizeSceneGeneratorDefinitions,
} from "../../../src/core/scene/scene-generator-registry";
import { staticValue } from "../../../src/core/types";
import { bundledParticleDefinition } from "../../../src/renderer/scene/bundled-particle-generator";

export function generatorCases(status: PluginStatus) {
  const errors = synchronizeSceneGeneratorDefinitions(status);
  if (errors.length) throw errors[0];
  const audioDefinition = getSceneGeneratorDefinitions().find(
    (d) => d.pluginId === "org.aster.example.audio-spectrum",
  );
  if (!audioDefinition) throw Error("Installed audio spectrum runtime missing");
  return ["billboard", "streak", "mesh", "clones", "audio-bars", "audio-ring", "audio-scope"].map(
    (id) => {
      const project = createBlankProject(),
        composition = project.compositions[0];
      composition.id = `generator-${id}`;
      composition.width = 320;
      composition.height = 240;
      const audio = id.startsWith("audio-");
      const definition = audio ? audioDefinition : bundledParticleDefinition;
      const instance = createSceneGeneratorInstance(definition);
      Object.assign(
        instance.parameters,
        audio
          ? {
              style: id.slice(6),
              count: 48,
              width: 260,
              height: 85,
              radius: 65,
              line_width: 3,
              frequency_min: 30,
              frequency_max: 4000,
              floor: 0,
              ceiling: 0.9,
              glow: 2,
              glow_strength: 0.3,
              cap_height: 2,
              spin: 12,
              scope_gain: 1.2,
            }
          : {
              renderMode: id === "clones" ? "billboard" : id,
              count: 257,
              seed: 243,
              lifetime: 1.5,
              emitterShape: "ring",
              emitterSize: [0.9, 0.65, 0.3],
              velocity: [0.1, 0.2, 0],
              startSize: 7,
              endSize: 3,
              startOpacity: 1,
              endOpacity: 0.4,
            },
      );
      const layer = createGeneratorLayerForComposition(composition, instance);
      layer.id = `layer-${id}`;
      layer.timeOffset = 0.25;
      layer.timeStretch = 2;
      if (audio) layer.transform.position[1] = staticValue(id === "audio-bars" ? 195 : 120);
      if (id === "clones")
        layer.cloner = {
          distribution: { kind: "grid", count: [2, 1, 1], spacing: [80, 0, 0] },
          effectors: [],
        };
      composition.layers = [layer];
      const rootTime = 1.1;
      const audioFrame = buildAudioAnalysisFrame(
        (start, length) =>
          Float32Array.from(
            { length },
            (_, i) =>
              0.4 * Math.sin(((start + i) * 2 * Math.PI * 440) / 48000) +
              0.2 * Math.sin(((start + i) * 2 * Math.PI * 1700) / 48000),
          ),
        rootTime,
      );
      return {
        id,
        composition,
        scenes: flattenSceneLayers(composition, project, 1.5),
        audio: audioFrame,
        rootTime,
      };
    },
  );
}
