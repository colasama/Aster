import { vi } from "vitest";

export function installGpuConstants(): void {
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
  vi.stubGlobal("GPUTextureUsage", {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    RENDER_ATTACHMENT: 8,
  });
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, UNIFORM: 2, STORAGE: 4, VERTEX: 8 });
}

export function blendPipelines() {
  const pipeline = {} as GPURenderPipeline;
  return {
    normal: pipeline,
    add: pipeline,
    multiply: pipeline,
    screen: pipeline,
    overlay: pipeline,
    darken: pipeline,
    lighten: pipeline,
    "color-burn": pipeline,
    "color-dodge": pipeline,
    "soft-light": pipeline,
    "hard-light": pipeline,
    difference: pipeline,
    exclusion: pipeline,
  };
}

export function mockDevice(
  textures: GPUTextureDescriptor[],
  destroy: ReturnType<typeof vi.fn>,
): GPUDevice {
  return {
    limits: { maxTextureDimension2D: 8_192, maxTextureDimension3D: 256 },
    queue: { writeTexture: vi.fn(), writeBuffer: vi.fn() },
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      textures.push(descriptor);
      return { createView: vi.fn(() => ({})), destroy };
    }),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createSampler: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
    createBindGroup: vi.fn(() => ({})),
  } as unknown as GPUDevice;
}

export function mockEncoder(events: string[]): GPUCommandEncoder {
  return {
    copyTextureToTexture: vi.fn(() => events.push("copy")),
    beginComputePass: vi.fn((descriptor: GPUComputePassDescriptor) => {
      events.push(`compute:${descriptor.label ?? "unnamed"}`);
      return {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(() => events.push("compute-end")),
      };
    }),
    beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
      events.push(`pass:${descriptor.label ?? "unnamed"}`);
      return {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        draw: vi.fn(() => events.push("draw")),
        end: vi.fn(() => events.push("end")),
      };
    }),
  } as unknown as GPUCommandEncoder;
}
