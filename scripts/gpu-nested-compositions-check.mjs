import { createLayerForComposition } from "/src/core/layers/layer-factory.ts";
import { createCompositionReference } from "/src/core/project/composition-source.ts";
import {
  createBlankComposition,
  createBlankProject,
  createDemoProject,
} from "/src/core/project/project.ts";
import { createEffect } from "/src/effects/registry.ts";
import { WebGpuRenderer } from "/src/renderer/webgpu-renderer.ts";

export async function run() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const renderer = await WebGpuRenderer.create(canvas);
  renderer.resize(64, 64);
  const project = createBlankProject();
  const root = project.compositions[0];
  root.width = root.height = 64;
  root.background = [0, 0, 0, 0];
  const child = createBlankComposition("Transparent source");
  child.width = child.height = 64;
  child.background = [0, 1, 0, 1];
  const shape = createLayerForComposition("shape", child);
  shape.size = [24, 24];
  shape.transform.anchor = [
    { mode: "static", value: 12 },
    { mode: "static", value: 12 },
    { mode: "static", value: 0 },
  ];
  shape.color = [1, 0, 0, 1];
  shape.shape = {
    kind: "rectangle",
    roundness: 0,
    strokeWidth: 0,
    strokeColor: [0, 0, 0, 0],
    fillMode: "solid",
    gradientColor: [1, 0, 0, 1],
    gradientAngle: 0,
    dashLength: 0,
    dashGap: 0,
    lineCap: "round",
    lineJoin: "round",
  };
  const second = structuredClone(shape);
  second.id = crypto.randomUUID();
  child.layers = [shape, second];
  project.compositions.push(child);
  const wrapper = createCompositionReference(project, root, child.id, 0);
  wrapper.transform.opacity = { mode: "static", value: 50 };
  root.layers = [wrapper];
  const render = async (time = 0) => {
    const snapshot = structuredClone(project);
    const frame = await renderer.renderRawFrame(snapshot.compositions[0], time, snapshot, true);
    await renderer.complete();
    return new Uint8Array(frame.pixels);
  };
  const pixel = (data, x, y) => Array.from(data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  const data = await render();
  if (pixel(data, 0, 0)[3] !== 0) throw new Error(`Nested background leaked: ${pixel(data, 0, 0)}`);
  if (Math.abs(pixel(data, 32, 32)[3] - 128) > 2)
    throw new Error(
      `Group opacity failed: ${pixel(data, 32, 32)} ${JSON.stringify(renderer.diagnostics)}`,
    );
  wrapper.transform.opacity = { mode: "static", value: 100 };
  const opaque = await render();
  for (let channel = 0; channel < 3; channel++)
    if (Math.abs(pixel(data, 32, 32)[channel] - pixel(opaque, 32, 32)[channel] * 0.5) > 2)
      throw new Error("Premultiplied color was multiplied by alpha twice");
  wrapper.transform.opacity = { mode: "static", value: 50 };
  child.layers = [shape];
  wrapper.effects = [createEffect("invert")];
  wrapper.transform.opacity = { mode: "static", value: 100 };
  const wrapperEffect = await render();
  const directEffect = structuredClone(shape);
  directEffect.effects = structuredClone(wrapper.effects);
  root.layers = [directEffect];
  const directEffectPixels = await render();
  if (wrapperEffect.some((value, index) => Math.abs(value - directEffectPixels[index]) > 2))
    throw new Error("Wrapper effect differs from a direct source effect");
  wrapper.effects = [];
  wrapper.transform.opacity = { mode: "static", value: 50 };
  wrapper.blendMode = "multiply";
  const backdrop = structuredClone(shape);
  backdrop.id = crypto.randomUUID();
  backdrop.color = [0, 0, 1, 1];
  backdrop.size = [64, 64];
  backdrop.transform.anchor[0].value = 32;
  backdrop.transform.anchor[1].value = 32;
  root.layers = [wrapper, backdrop];
  const nestedBlend = await render();
  directEffect.effects = [];
  directEffect.blendMode = "multiply";
  directEffect.transform.opacity = { mode: "static", value: 50 };
  root.layers = [directEffect, backdrop];
  const directBlend = await render();
  if (nestedBlend.some((value, index) => Math.abs(value - directBlend[index]) > 2))
    throw new Error("Wrapper blend differs from a direct source blend");
  wrapper.blendMode = "normal";
  child.layers = [shape, second];
  const a = createLayerForComposition("shape", root),
    b = structuredClone(a);
  b.id = crypto.randomUUID();
  for (const [layer, color, rotation] of [
    [a, [1, 0, 0, 0.5], 35],
    [b, [0, 0, 1, 0.5], -35],
  ]) {
    layer.size = [40, 40];
    layer.color = color;
    layer.shape = structuredClone(shape.shape);
    layer.threeDimensional = true;
    layer.transform.anchor = [
      { mode: "static", value: 20 },
      { mode: "static", value: 20 },
      { mode: "static", value: 0 },
    ];
    layer.transform.rotation[1] = { mode: "static", value: rotation };
  }
  root.layers = [a, b];
  const crossing = await render();
  const left = pixel(crossing, 23, 32),
    right = pixel(crossing, 41, 32);
  if (Math.abs(left[3] - 191) > 3 || Math.abs(right[3] - 191) > 3)
    throw new Error(`Crossing alpha failed: ${left} / ${right}`);
  if ((left[0] - left[2]) * (right[0] - right[2]) >= 0)
    throw new Error(`Crossing depth did not reverse: ${left} / ${right}`);
  root.layers = [b, a];
  const reversed = await render();
  if (crossing.some((value, index) => Math.abs(value - reversed[index]) > 1))
    throw new Error("Transparent result depends on submission order");
  // Collapsing a source joins its 3D child with the parent's depth group.
  child.layers = [a];
  const collapsed = createCompositionReference(project, root, child.id, 0);
  collapsed.collapseTransformations = true;
  root.layers = [b, collapsed];
  const collapsedPixels = await render();
  if (crossing.some((value, index) => Math.abs(value - collapsedPixels[index]) > 1))
    throw new Error("Collapsed source does not share parent depth");
  // Normal nesting is an isolated plane and must not inherit its child's depth.
  collapsed.collapseTransformations = false;
  const isolatedPixels = await render();
  if (!isolatedPixels.some((value, index) => Math.abs(value - collapsedPixels[index]) > 5))
    throw new Error("Normal precomp unexpectedly shares child depth");
  // Six independent source clocks exceed the old four-surface ceiling.
  child.layers = [shape];
  root.layers = Array.from({ length: 6 }, (_, index) => {
    const layer = createCompositionReference(project, root, child.id, 0);
    layer.timeOffset = index * 0.1;
    layer.transform.position[0].value = 8 + index * 9;
    layer.size = [8, 8];
    layer.transform.anchor[0].value = 4;
    layer.transform.anchor[1].value = 4;
    return layer;
  });
  const six = await render();
  for (let index = 0; index < 6; index++)
    if (pixel(six, 8 + index * 9, 32)[3] < 250) throw new Error("A nested surface was omitted");
  root.layers = [wrapper];
  wrapper.timeRemap = { mode: "static", value: -1 };
  const outside = await render();
  if (outside.some((value, index) => index % 4 === 3 && value !== 0))
    throw new Error("Negative source time held frame zero");
  const demo = createDemoProject().compositions[0];
  const mesh = structuredClone(demo.layers.find((layer) => layer.kind === "mesh"));
  mesh.size = [40, 40];
  mesh.transform.position = [
    { mode: "static", value: 32 },
    { mode: "static", value: 32 },
    { mode: "static", value: 0 },
  ];
  mesh.transform.anchor = [
    { mode: "static", value: 20 },
    { mode: "static", value: 20 },
    { mode: "static", value: 0 },
  ];
  const light = createLayerForComposition("light", root);
  root.environment = demo.environment;
  root.layers = [light, mesh];
  const materialDirect = await render();
  if (!materialDirect.some((value, index) => index % 4 === 3 && value > 128))
    throw new Error("Material fixture did not render");
  child.environment = demo.environment;
  child.layers = [light, mesh];
  root.environment = undefined;
  root.layers = [wrapper];
  wrapper.timeRemap = undefined;
  wrapper.transform.opacity = { mode: "static", value: 100 };
  const materialNested = await render();
  if (materialDirect.some((value, index) => Math.abs(value - materialNested[index]) > 2))
    throw new Error("Nested material/light result differs from standalone source");
  const camera = createLayerForComposition("camera", root);
  camera.camera.depthOfField = true;
  camera.camera.lockFocusToZoom = false;
  camera.camera.focusDistance = { mode: "static", value: 180 };
  camera.camera.aperture = { mode: "static", value: 12 };
  const plane = structuredClone(shape);
  plane.threeDimensional = true;
  root.layers = [camera, plane];
  const dofDirect = await render();
  child.layers = [camera, plane];
  child.environment = undefined;
  root.layers = [wrapper];
  const dofNested = await render();
  if (dofDirect.some((value, index) => Math.abs(value - dofNested[index]) > 2))
    throw new Error(
      `Nested camera depth of field differs: ${pixel(dofDirect, 32, 32)} / ${pixel(dofNested, 32, 32)}, max ${Math.max(...dofDirect.map((value, index) => Math.abs(value - dofNested[index])))} edge ${pixel(dofDirect, 18, 32)} / ${pixel(dofNested, 18, 32)} diff ${JSON.stringify(
        Array.from(dofDirect)
          .map((value, index) => ({
            index,
            value,
            nested: dofNested[index],
            diff: Math.abs(value - dofNested[index]),
          }))
          .filter((v) => v.diff > 2)
          .slice(0, 8),
      )}`,
    );
  root.layers = [plane];
  const sharp = await render();
  if (!sharp.some((value, index) => Math.abs(value - dofNested[index]) > 5))
    throw new Error("Depth of field fixture did not blur");
  const moving = structuredClone(shape);
  moving.motionBlur = true;
  moving.transform.position[0] = {
    mode: "animated",
    keyframes: [
      { id: "start", time: 0, value: -568, interpolation: "linear" },
      { id: "end", time: 2, value: 632, interpolation: "linear" },
    ],
  };
  root.motionBlur.enabled = true;
  root.layers = [moving];
  const motionDirect = await render(1);
  child.motionBlur = structuredClone(root.motionBlur);
  child.layers = [moving];
  root.motionBlur.enabled = false;
  root.layers = [wrapper];
  const motionNested = await render(1);
  if (motionDirect.some((value, index) => Math.abs(value - motionNested[index]) > 2))
    throw new Error("Nested motion blur differs from standalone source");
  // Warm production-sized intersection, including GPU completion (no pixel readback).
  root.width = 1920;
  root.height = 1080;
  root.layers = [a, b];
  for (const layer of root.layers) {
    layer.size = [1400, 800];
    layer.transform.anchor[0].value = 700;
    layer.transform.anchor[1].value = 400;
    layer.transform.position[0].value = 960;
    layer.transform.position[1].value = 540;
  }
  renderer.resize(1920, 1080);
  const benchmarkProject = structuredClone(project);
  const milliseconds = [];
  for (let frame = 0; frame < 12; frame++) {
    const start = performance.now();
    renderer.render(benchmarkProject.compositions[0], frame / 30, false, benchmarkProject);
    await renderer.complete();
    if (frame >= 2) milliseconds.push(performance.now() - start);
  }
  milliseconds.sort((a, b) => a - b);
  const benchmark = {
    resolution: "1920x1080",
    samples: milliseconds.length,
    medianMs: milliseconds[Math.floor(milliseconds.length / 2)],
    maxMs: milliseconds.at(-1),
    adapter: renderer.diagnostics.adapter,
  };
  renderer.resize(64, 64);
  root.width = root.height = 64;
  root.layers = Array.from({ length: 129 }, () => {
    const layer = structuredClone(shape);
    layer.id = crypto.randomUUID();
    layer.threeDimensional = true;
    layer.color[3] = 0.01;
    return layer;
  });
  let overflowReported = false;
  try {
    await render();
  } catch (error) {
    overflowReported = String(error).includes("fragment pixel capacity");
  }
  if (!overflowReported) throw new Error("Transparency overflow was not reported");
  renderer.dispose();
  return {
    groupOpacity: pixel(data, 32, 32),
    background: pixel(data, 0, 0),
    crossing: { left, right },
    orderIndependent: true,
    collapsedDepth: true,
    sixSurfaces: true,
    nestedMaterials: true,
    wrapperEffectsAndBlend: true,
    nestedDepthOfField: true,
    nestedMotionBlur: true,
    overflowReported,
    benchmark,
  };
}
