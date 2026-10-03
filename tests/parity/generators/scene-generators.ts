import { createGeneratorLayerForComposition } from "../../../src/core/layers/layer-factory";
import { createParticleSceneGenerator } from "../../../src/core/scene/bundled-particle";
import { createDefaultParticleSettings } from "../../../src/core/scene/particle-settings";
import { createId, staticValue } from "../../../src/core/types";
import type { GeneratedCase } from "../types";
import { caseFor, fixture } from "./base";
import { attachAudioFixture } from "./media";
import { motion, rectangle } from "./scene-shared";

export function buildGeneratorCases(): GeneratedCase[] {
  return [
    ...(["billboard", "streak", "mesh"] as const).map(particleScene),
    clonerScene(),
    ...(["bars", "ring", "scope"] as const).map(audioScene),
  ];
}

function particleScene(renderMode: "billboard" | "streak" | "mesh"): GeneratedCase {
  const id = `scene-particles-${renderMode}`;
  const scene = fixture(id);
  const settings = createDefaultParticleSettings();
  Object.assign(settings, {
    renderMode,
    count: 256,
    seed: 243,
    lifetime: 1.5,
    emitterShape: "ring",
    emitterSize: [0.9, 0.65, 0.3],
    velocity: [0.1, 0.2, 0],
    startSize: 5,
    endSize: 2,
    startOpacity: 1,
    endOpacity: 0.4,
  });
  const generator = createGeneratorLayerForComposition(
    scene.composition,
    createParticleSceneGenerator(settings),
    0,
    `${renderMode} time-addressed particles`,
  );
  generator.blendMode = "add";
  scene.composition.layers = [generator];
  return caseFor(id, scene.project, ["layer:generator", "feature:bundled-particles"], {
    frames: [3, 15, 30, 54],
    sequence: true,
  });
}

function clonerScene(): GeneratedCase {
  const scene = fixture("scene-cloners");
  const grid = rectangle(scene, "Seeded grid clones", [88, 90, 0], [15, 15], [0.15, 0.65, 1, 1]);
  grid.cloner = {
    distribution: { kind: "grid", count: [4, 3, 1], spacing: [30, 30, 0] },
    effectors: [
      {
        id: createId(),
        kind: "random",
        enabled: true,
        strength: 0.6,
        seed: 719,
        position: [4, 4, 0],
        scale: [15, 15, 0],
        rotation: [0, 0, 25],
      },
    ],
  };
  const radial = rectangle(
    scene,
    "Rotating radial clones",
    [238, 90, 0],
    [12, 20],
    [0.95, 0.3, 0.08, 1],
  );
  radial.cloner = {
    distribution: {
      kind: "radial",
      count: 11,
      radius: 52,
      startAngle: 0,
      endAngle: 360,
      axis: "z",
      alignRotation: true,
    },
    effectors: [],
  };
  radial.transform.rotation[2] = motion(0, 100);
  scene.composition.layers = [grid, radial];
  return caseFor("scene-cloners", scene.project, ["layer:shape", "feature:cloner"], {
    sequence: true,
  });
}

function audioScene(style: "bars" | "ring" | "scope"): GeneratedCase {
  const id = `scene-audio-spectrum-${style}`;
  const scene = fixture(id);
  const source = attachAudioFixture(scene.project);
  const audio = scene.layer("audio", "Deterministic tone and pulse source");
  audio.sourceId = source.id;
  const generator = createGeneratorLayerForComposition(
    scene.composition,
    {
      pluginId: "org.aster.example.audio-spectrum",
      nodeType: "audio_spectrum",
      apiVersion: 1,
      parameters: {
        style,
        count: 48,
        width: 265,
        height: 85,
        radius: 47,
        line_width: 2,
        frequency_min: 30,
        frequency_max: 4000,
        floor: 0,
        ceiling: 0.9,
        glow: 2,
        glow_strength: 0.3,
        cap_height: 2,
        spin: 12,
        scope_gain: 1.2,
      },
    },
    0,
    "Audio-driven GPU spectrum",
  );
  generator.transform.position[1] = staticValue(style === "bars" ? 145 : 90);
  scene.composition.layers = [generator, audio];
  return caseFor(
    id,
    scene.project,
    [
      "layer:generator",
      "layer:audio",
      "feature:audio-analysis",
      "plugin:org.aster.example.audio-spectrum",
    ],
    { plugins: ["examples/plugins/audio-spectrum"], frames: [3, 6, 15, 33, 54], sequence: true },
  );
}
