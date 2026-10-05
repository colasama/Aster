import {
  createGeneratorLayerForComposition,
  createLayerForComposition,
} from "../../../src/core/layers/layer-factory";
import { createBlankProject } from "../../../src/core/project/project";
import { flattenSceneLayers } from "../../../src/core/scene/scene-evaluation";
import { createSceneGeneratorInstance } from "../../../src/core/scene/scene-generator-registry";
import { type Composition, staticValue } from "../../../src/core/types";
import { createEffect } from "../../../src/effects/registry";
import { bundledParticleDefinition } from "../../../src/renderer/scene/bundled-particle-generator";

export function surfaceFixture(id: string) {
  const project = createBlankProject();
  const root = project.compositions[0];
  root.id = `root-${id}`;
  root.width = 64;
  root.height = 48;
  const leaf = {
    ...structuredClone(root),
    id: `leaf-${id}`,
    name: "Leaf",
    background: [0.04, 0.07, 0.12, 0.25] as [number, number, number, number],
  };
  leaf.layers = [0, 1].map((i) => {
    const layer = createLayerForComposition("shape", leaf);
    layer.id = `shape-${i}`;
    layer.size = [30, 26];
    layer.color = i ? [0.1, 0.3, 0.9, 0.7] : [0.9, 0.2, 0.1, 0.8];
    layer.transform.anchor = [staticValue(15), staticValue(13), staticValue(0)];
    layer.transform.position = [staticValue(23 + i * 15), staticValue(21 + i * 7), staticValue(0)];
    return layer;
  });
  if (id === "media") {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    if (!context) throw Error("No media fixture canvas");
    const image = context.createImageData(64, 48);
    for (let i = 0; i < 64 * 48; i++)
      image.data.set([i % 251, (i * 7) % 251, 210, 128 + (i % 2) * 80], i * 4);
    context.putImageData(image, 0, 0);
    project.sources.push({
      id: "captured-image",
      name: "captured-image.png",
      kind: "still",
      mimeType: "image/png",
      contentIdentity: "recursive-media-fixture-v1",
      dataUrl: canvas.toDataURL("image/png"),
      width: 64,
      height: 48,
      interpretation: { alpha: "straight", colorSpace: "srgb" },
    });
    const layer = createLayerForComposition("image", leaf);
    layer.id = "image";
    layer.sourceId = "captured-image";
    layer.size = [64, 48];
    layer.transform.anchor = [staticValue(32), staticValue(24), staticValue(0)];
    leaf.layers.unshift(layer);
  }
  if (id === "effects") leaf.layers[0].effects = [createEffect("gaussian-blur")];
  if (id.startsWith("generator")) {
    const instance = createSceneGeneratorInstance(bundledParticleDefinition);
    Object.assign(instance.parameters, {
      renderMode: "billboard",
      count: 80,
      seed: 243,
      lifetime: 1.5,
      emitterShape: "ring",
      emitterSize: [0.7, 0.5, 0.1],
      velocity: [0.1, 0.2, 0],
      startSize: 5,
      endSize: 3,
      startOpacity: 1,
      endOpacity: 0.7,
    });
    const generator = createGeneratorLayerForComposition(leaf, instance);
    generator.id = "particles";
    generator.effects = [createEffect("exposure")];
    leaf.layers.unshift(generator);
  }
  project.compositions.push(leaf);
  const wrapper = (composition: Composition, source: Composition, name: string) => {
    const layer = createLayerForComposition("precomposition", composition);
    layer.id = name;
    layer.sourceCompositionId = source.id;
    layer.size = [64, 48];
    layer.transform.anchor = [staticValue(32), staticValue(24), staticValue(0)];
    layer.threeDimensional = true;
    return layer;
  };
  let source = leaf;
  if (id === "nested" || id === "effects" || id === "media") {
    const parent = { ...structuredClone(root), id: `parent-${id}`, name: "Parent" };
    parent.layers = ["left", "right"].map((name, i) => {
      const layer = wrapper(parent, leaf, name);
      layer.transform.position[0] = staticValue(i ? 43 : 22);
      layer.transform.scale = [staticValue(70), staticValue(70), staticValue(100)];
      return layer;
    });
    if (id === "effects") {
      const adjustment = createLayerForComposition("adjustment", parent);
      adjustment.id = "invert";
      adjustment.effects = [createEffect("invert")];
      parent.layers.unshift(adjustment);
    }
    source = parent;
    project.compositions.push(parent);
  }
  root.layers = [wrapper(root, source, "output")];
  const scene = flattenSceneLayers(root, project, 1.25);
  return { project, scene, output: scene[0].instanceId };
}
