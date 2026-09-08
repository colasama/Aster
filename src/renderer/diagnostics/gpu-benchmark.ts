import {
  createParticleLayerForComposition,
  createParticleSceneGenerator,
} from "../../core/scene/bundled-particle";
import { createDefaultParticleSettings } from "../../core/scene/particle-settings";
import type { Composition, Project, RendererMetrics } from "../../core/types";
import { createId } from "../../core/types";
import { createEffect } from "../../effects/registry";

const WARMUP_FRAMES = 10;

export interface BenchmarkDistribution {
  minimum: number;
  median: number;
  p95: number;
  p99: number;
  maximum: number;
}

export interface GpuBenchmarkScenarioReport {
  name: string;
  width: number;
  height: number;
  layers: number;
  effects: number;
  wallMs: BenchmarkDistribution;
  cpuMs: BenchmarkDistribution;
  gpuMs: BenchmarkDistribution;
}

export interface GpuBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  adapter: string;
  backend: string;
  warmupFrames: number;
  sampleFrames: number;
  scenarios: GpuBenchmarkScenarioReport[];
}

export interface BenchmarkRenderer {
  resize(width: number, height: number): void;
  render(
    composition: Composition,
    time: number,
    playing?: boolean,
    project?: Project,
  ): RendererMetrics;
  complete(): Promise<void>;
}

export interface GpuBenchmarkRequest {
  sampleFrames: number;
  onProgress: (scenario: string, completed: number, total: number) => void;
  accept: () => void;
  reject: (error: unknown) => void;
  resolve: (report: GpuBenchmarkReport) => void;
}

interface BenchmarkScenario {
  name: string;
  composition: Composition;
}

export async function runGpuBenchmark(
  renderer: BenchmarkRenderer,
  canvas: HTMLCanvasElement,
  composition: Composition,
  project: Project,
  currentTime: number,
  adapter: string,
  backend: string,
  sampleFrames: number,
  onProgress: GpuBenchmarkRequest["onProgress"],
): Promise<GpuBenchmarkReport> {
  const preview = { width: canvas.width, height: canvas.height };
  const samples = Math.max(1, Math.floor(sampleFrames));
  const scenarios = buildBenchmarkScenarios(composition);
  const reports: GpuBenchmarkScenarioReport[] = [];
  try {
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const { width, height } = scenario.composition;
      canvas.width = width;
      canvas.height = height;
      renderer.resize(width, height);
      for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) {
        renderer.render(
          scenario.composition,
          (frame / 60) % scenario.composition.duration,
          false,
          project,
        );
        await renderer.complete();
      }
      const wall: number[] = [];
      const cpu: number[] = [];
      const gpu: number[] = [];
      for (let frame = 0; frame < samples; frame += 1) {
        const started = performance.now();
        const metrics = renderer.render(
          scenario.composition,
          (frame / 60) % scenario.composition.duration,
          false,
          project,
        );
        await renderer.complete();
        wall.push(performance.now() - started);
        cpu.push(metrics.cpuMs);
        if (metrics.gpuMs !== undefined) gpu.push(metrics.gpuMs);
        if (frame % 10 === 9 || frame === samples - 1)
          onProgress(
            scenario.name,
            scenarioIndex * samples + frame + 1,
            scenarios.length * samples,
          );
        if (frame % 30 === 29) await nextPaint();
      }
      reports.push({
        name: scenario.name,
        width,
        height,
        layers: scenario.composition.layers.length,
        effects: scenario.composition.layers.reduce(
          (count, layer) => count + layer.effects.length,
          0,
        ),
        wallMs: summarizeSamples(wall),
        cpuMs: summarizeSamples(cpu),
        gpuMs: summarizeSamples(gpu),
      });
    }
  } finally {
    canvas.width = preview.width;
    canvas.height = preview.height;
    renderer.resize(preview.width, preview.height);
    renderer.render(composition, currentTime, false, project);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    adapter,
    backend,
    warmupFrames: WARMUP_FRAMES,
    sampleFrames: samples,
    scenarios: reports,
  };
}

export function buildBenchmarkScenarios(source: Composition): BenchmarkScenario[] {
  const resolution = (name: string, width: number, height: number): BenchmarkScenario => ({
    name,
    composition: { ...structuredClone(source), id: createId(), width, height },
  });
  const twentyLayers = resolution("20-layer 1080p composite", 1920, 1080);
  const candidates = source.layers.filter(
    (layer) => layer.kind !== "camera" && layer.kind !== "light",
  );
  twentyLayers.composition.layers = Array.from({ length: 20 }, (_, index) => {
    const template = candidates[index % Math.max(1, candidates.length)] ?? source.layers[0];
    if (!template) throw new Error("Benchmark composition requires at least one layer");
    return {
      ...structuredClone(template),
      id: createId(),
      name: `${template.name} · ${index + 1}`,
      parentId: undefined,
      blendMode: index % 3 === 0 ? "screen" : template.blendMode,
    };
  });
  const effectChain = resolution("Blur + glow effect chain", 1920, 1080);
  const effectLayer = effectChain.composition.layers.find(
    (layer) => layer.kind === "text" || layer.kind === "shape" || layer.kind === "image",
  );
  if (effectLayer) {
    effectChain.composition.layers = [effectLayer];
    effectLayer.parentId = undefined;
    effectLayer.effects = [
      createEffect("gaussian-blur"),
      createEffect("glow"),
      createEffect("curves"),
      createEffect("chromatic"),
      createEffect("exposure"),
    ];
  }
  const particleScenario = (count: number): BenchmarkScenario => {
    const label = count === 1_000_000 ? "1M" : `${count / 1000}K`;
    const scenario = resolution(`${label} GPU particles`, 1920, 1080);
    const sourceParticle = source.layers.find((layer) => layer.kind === "generator");
    const particle = sourceParticle
      ? structuredClone(sourceParticle)
      : createParticleLayerForComposition(scenario.composition);
    particle.id = createId();
    particle.parentId = undefined;
    particle.name = `${label} GPU particles`;
    particle.generator = createParticleSceneGenerator({
      ...createDefaultParticleSettings(),
      renderMode: "billboard",
      count,
    });
    scenario.composition.layers = [particle];
    return scenario;
  };
  return [
    resolution("1080p current composition", 1920, 1080),
    resolution("4K current composition", 3840, 2160),
    twentyLayers,
    effectChain,
    particleScenario(100_000),
    particleScenario(500_000),
    particleScenario(1_000_000),
  ];
}

export function summarizeSamples(samples: number[]): BenchmarkDistribution {
  const values = samples.filter(Number.isFinite).sort((left, right) => left - right);
  if (!values.length) return { minimum: 0, median: 0, p95: 0, p99: 0, maximum: 0 };
  return {
    minimum: values[0],
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    maximum: values[values.length - 1],
  };
}

function percentile(values: number[], position: number): number {
  const index = position * (values.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return values[lower] * (1 - weight) + values[upper] * weight;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
