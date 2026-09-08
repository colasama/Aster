// Import run() from a WebGPU browser served by Vite.
import { createLayerForComposition } from "/src/core/layer-factory.ts";
import { createBlankProject } from "/src/core/project.ts";
import { flattenSceneLayers } from "/src/core/scene-evaluation.ts";
import { materialShapeShader, shapeShader } from "/src/renderer/base-shaders.ts";
import { buildSceneLighting, SCENE_LIGHTING_BYTES } from "/src/renderer/scene-lighting.ts";
import { SHAPE_VERTEX_BUFFERS } from "/src/renderer/scene-pipelines.ts";

export async function run() {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  for (const code of [shapeShader, materialShapeShader]) {
    const info = await device.createShaderModule({ code }).getCompilationInfo();
    errors.push(...info.messages.filter((m) => m.type === "error").map((m) => m.message));
  }
  const module = device.createShaderModule({ code: shapeShader });
  const pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main", buffers: SHAPE_VERTEX_BUFFERS },
    fragment: { module, entryPoint: "fragment_main", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  });
  const uniforms = device.createBuffer({
    size: SCENE_LIGHTING_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const shadow = device.createTexture({
    size: [1, 1],
    format: "depth32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const target = device.createTexture({
    size: [1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const vertices = new Float32Array(40 * 3);
  for (const [index, xy] of [
    [0, [-1, -1]],
    [1, [3, -1]],
    [2, [-1, 3]],
  ]) {
    const offset = index * 40;
    vertices.set([...xy, 0, 0.5, 0.5, 0.2, 0.2, 0.2, 1, 0, 0, 0, -1, 0, 0.5, 0, 1], offset);
    vertices[offset + 23] = 1;
  }
  const vertexBuffer = device.createBuffer({
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertices);
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 1, resource: shadow.createView() },
      { binding: 2, resource: device.createSampler({ compare: "less-equal" }) },
    ],
  });
  const project = createBlankProject(),
    composition = project.compositions[0];
  const main = createLayerForComposition("light", composition);
  main.color = [1, 0, 0, 1];
  main.light.intensity = 1;
  main.transform.rotation[1].value = 180;
  const fill = createLayerForComposition("light", composition);
  fill.color = [0, 1, 0, 1];
  fill.light.intensity = 1;
  fill.transform.rotation[1].value = 180;
  const draw = async (layers) => {
    composition.layers = layers;
    device.queue.writeBuffer(
      uniforms,
      0,
      buildSceneLighting(
        flattenSceneLayers(composition, project, 0),
        composition,
        false,
        [0, 0, -10],
      ),
    );
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      [1, 1],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)];
    readback.unmap();
    return result;
  };
  const single = await draw([main]);
  const dual = await draw([main, fill]);
  if (!(dual[1] > single[1] + 40 && Math.abs(dual[0] - single[0]) <= 1))
    throw Error("Secondary light did not add independent green illumination");
  fill.light.kind = "point";
  fill.light.range = 100;
  fill.transform.position.forEach((track) => {
    track.value = 0;
  });
  fill.transform.position[2].value = -10;
  const near = await draw([main, fill]);
  fill.transform.position[2].value = -200;
  const far = await draw([main, fill]);
  if (!(near[1] > far[1] + 30)) throw Error("Point-light attenuation was not applied");
  fill.light.kind = "spot";
  fill.light.coneAngle = 45;
  fill.transform.position[2].value = -10;
  fill.transform.rotation[1].value = 0;
  const spotIn = await draw([main, fill]);
  fill.transform.rotation[1].value = 90;
  const spotOut = await draw([main, fill]);
  if (!(spotIn[1] > spotOut[1] + 30)) throw Error("Spot cone was not applied");
  fill.visible = false;
  const hidden = await draw([main, fill]);
  if (hidden.some((v, i) => v !== single[i])) throw Error("Hidden light affected the render");
  await device.queue.onSubmittedWorkDone();
  for (const resource of [uniforms, shadow, target, readback, vertexBuffer]) resource.destroy();
  device.destroy();
  if (errors.length) throw Error(errors.join("\n"));
  return { single, dual, near, far, spotIn, spotOut, hidden, errors };
}
