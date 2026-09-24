// Import run() from an unbundled Vite WebGPU browser and supply the prior postProcessShader string.
import { createLayerForComposition } from "/src/core/layers/layer-factory.ts";
import { createBlankProject } from "/src/core/project/project.ts";
import { createEffect } from "/src/effects/registry.ts";
import { defaultPostProcessParameters } from "/src/renderer/effects/effect-parameters.ts";
import { compileEffectProgram } from "/src/renderer/effects/effect-program.ts";
import { buildPostProcessUniforms } from "/src/renderer/effects/post-process.ts";
import { postProcessShader } from "/src/renderer/gpu/shaders.ts";
import {
  createLutSampler,
  createLutTexture,
  float32ToFloat16,
} from "/src/renderer/media/lut-texture.ts";

const CASES = [
  ["inactive", {}],
  ["blur", { blur: 8 }],
  ["negative-blur", { blur: -2 }],
  ["glow", { glow: 0.7 }],
  ["negative-glow", { glow: -0.3 }],
  ["chromatic-positive", { chromatic: 5 }],
  ["chromatic-negative", { chromatic: -5 }],
  ["all-active", { blur: 3, glow: 0.4, chromatic: -3 }],
];

export async function run({
  baselineShader,
  width = 1920,
  height = 1080,
  frameCount = 600,
  passesPerSample = 8,
  runs = 3,
  benchmark = true,
} = {}) {
  if (typeof baselineShader !== "string" || baselineShader === postProcessShader)
    throw new Error("Supply the distinct prior postProcessShader source as baselineShader");
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 2048)
    throw new Error("frameCount must be an integer between 1 and 2048");
  if (!Number.isInteger(passesPerSample) || passesPerSample < 1 || passesPerSample > 16)
    throw new Error("passesPerSample must be an integer between 1 and 16");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const timestampQueries = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({
    requiredFeatures: timestampQueries ? ["timestamp-query"] : [],
  });
  const errors = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  try {
    const pipelines = await Promise.all(
      [baselineShader, postProcessShader].map(async (code) => {
        const module = device.createShaderModule({ code });
        const compilation = await module.getCompilationInfo();
        const failures = compilation.messages.filter((message) => message.type === "error");
        if (failures.length) throw new Error(failures.map((failure) => failure.message).join("\n"));
        return device.createRenderPipelineAsync({
          layout: "auto",
          vertex: { module, entryPoint: "vertex_main" },
          fragment: { module, entryPoint: "fragment_main", targets: [{ format: "rgba16float" }] },
        });
      }),
    );
    const parity = await checkParity(device, pipelines);
    const measurements = [];
    if (benchmark) {
      if (!timestampQueries) throw new Error("GPU timestamps are required for the microbenchmark");
      const fixture = createFixture(device, pipelines, width, height);
      try {
        for (const name of ["inactive", "all-active"]) {
          const effects = CASES.find(([caseName]) => caseName === name)[1];
          fixture.setUniforms(effects, true, 0);
          for (let run = 0; run < runs; run++) {
            const order = run % 2 === 0 ? [0, 1] : [1, 0];
            for (const arm of order) {
              const warmup = device.createCommandEncoder();
              for (let frame = 0; frame < 120; frame++) fixture.encode(warmup, arm);
              device.queue.submit([warmup.finish()]);
              await device.queue.onSubmittedWorkDone();
              const gpuMs = await measure(device, fixture, arm, frameCount, passesPerSample);
              measurements.push({
                case: name,
                run: run + 1,
                arm: arm === 0 ? "baseline" : "optimized",
                ...distribution(gpuMs),
                gpuMs,
              });
            }
          }
        }
      } finally {
        fixture.destroy();
      }
    }
    if (errors.length) throw new Error(errors.join("\n"));
    return {
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      timestampQueries,
      width,
      height,
      frameCount,
      passesPerSample,
      warmupPasses: 120,
      parity,
      measurements,
      gpuErrors: errors,
    };
  } finally {
    device.destroy();
  }
}

async function checkParity(device, pipelines) {
  const width = 32;
  const height = 16;
  const fixture = createFixture(device, pipelines, width, height);
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.width = width;
  composition.height = height;
  const layer = createLayerForComposition("shape", composition);
  const programs = [[], [createEffect("exposure")], [createEffect("twirl")]];
  programs[1][0].parameters.exposure = 1.3;
  programs[2][0].parameters.angle = 23;
  const results = [];
  try {
    for (let programIndex = 0; programIndex < programs.length; programIndex++) {
      layer.effects = programs[programIndex];
      const program = compileEffectProgram(composition, 0.75, [layer]);
      fixture.setProgram(program.data);
      for (const linearOutput of [false, true])
        for (const [name, effects] of CASES) {
          fixture.setUniforms(effects, linearOutput, program.count);
          const pixels = [];
          for (const arm of [0, 1]) {
            const encoder = device.createCommandEncoder();
            fixture.encode(encoder, arm);
            pixels.push(await fixture.read(encoder));
          }
          const mismatch = pixels[0].findIndex((value, index) => value !== pixels[1][index]);
          if (mismatch !== -1)
            throw new Error(
              `${name}, program ${programIndex}, linear=${linearOutput}: byte ${mismatch} differs (${pixels[0][mismatch]} vs ${pixels[1][mismatch]})`,
            );
          results.push({ name, programIndex, linearOutput, identicalBytes: pixels[0].length });
        }
    }
    return results;
  } finally {
    fixture.destroy();
  }
}

function createFixture(device, pipelines, width, height) {
  const source = device.createTexture({
    size: [width, height],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const output = device.createTexture({
    size: [width, height],
    format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const data = new Uint16Array(width * height * 4);
  const alphas = [0, 2 ** -24, 0.000009, 0.00001, 0.000011, 0.001, 0.25, 1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha = alphas[y % alphas.length];
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        data[offset + channel] = float32ToFloat16((((x * (channel + 3) + y) % 37) / 3) * alpha);
      data[offset + 3] = float32ToFloat16(alpha);
    }
  device.queue.writeTexture({ texture: source }, data, { bytesPerRow: width * 8 }, [width, height]);
  const lut = createLutTexture(device);
  const lutSampler = createLutSampler(device);
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const uniform = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const program = device.createBuffer({
    size: 4096,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const bindings = pipelines.map((pipeline) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: uniform } },
        { binding: 3, resource: { buffer: program } },
        { binding: 4, resource: lut.createView({ dimension: "3d" }) },
        { binding: 5, resource: lutSampler },
      ],
    }),
  );
  const outputView = output.createView();
  const pitch = Math.ceil((width * 8) / 256) * 256;
  return {
    setUniforms(effects, linearOutput, operationCount) {
      device.queue.writeBuffer(
        uniform,
        0,
        buildPostProcessUniforms(
          width,
          height,
          0.75,
          { ...defaultPostProcessParameters(), ...effects },
          operationCount,
          linearOutput,
        ),
      );
    },
    setProgram(data) {
      device.queue.writeBuffer(program, 0, data);
    },
    encode(encoder, arm, timestampWrites) {
      const pass = encoder.beginRenderPass({
        timestampWrites,
        colorAttachments: [
          { view: outputView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] },
        ],
      });
      pass.setPipeline(pipelines[arm]);
      pass.setBindGroup(0, bindings[arm]);
      pass.draw(3);
      pass.end();
    },
    async read(encoder) {
      const readback = device.createBuffer({
        size: pitch * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: pitch }, [
        width,
        height,
      ]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const result = new Uint8Array(readback.getMappedRange()).slice();
      readback.unmap();
      readback.destroy();
      return result;
    },
    destroy() {
      for (const resource of [source, output, lut, uniform, program]) resource.destroy();
    },
  };
}

async function measure(device, fixture, arm, frameCount, passesPerSample) {
  const query = device.createQuerySet({ type: "timestamp", count: frameCount * 2 });
  const size = frameCount * 16;
  const resolve = device.createBuffer({
    size,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder();
    // Average several passes inside each timestamp interval to reduce timer quantization.
    for (let frame = 0; frame < frameCount; frame++)
      for (let pass = 0; pass < passesPerSample; pass++)
        fixture.encode(
          encoder,
          arm,
          pass === 0 || pass === passesPerSample - 1
            ? {
                querySet: query,
                beginningOfPassWriteIndex: pass === 0 ? frame * 2 : undefined,
                endOfPassWriteIndex: pass === passesPerSample - 1 ? frame * 2 + 1 : undefined,
              }
            : undefined,
        );
    encoder.resolveQuerySet(query, 0, frameCount * 2, resolve, 0);
    encoder.copyBufferToBuffer(resolve, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const times = new BigUint64Array(readback.getMappedRange());
    const gpuMs = Array.from(
      { length: frameCount },
      (_, index) => Number(times[index * 2 + 1] - times[index * 2]) / 1e6 / passesPerSample,
    );
    readback.unmap();
    return gpuMs;
  } finally {
    query.destroy();
    resolve.destroy();
    readback.destroy();
  }
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return { medianMs: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99) };
}
