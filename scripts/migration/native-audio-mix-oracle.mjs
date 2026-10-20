import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureAudioMixOracle(root, output) {
  const paths = [
    "scripts/migration/native-audio-mix-oracle.mjs",
    "src/core/audio/audio-mixer.ts",
    "src/core/audio/audio-layer.ts",
    "src/core/audio/audio-analysis-frame.ts",
    "src/core/animation/layer-time.ts",
    "src/core/project/project-schema.ts",
    "artifacts/parity/projects/media-audio/project.json",
  ];
  const sources = await Promise.all(
    paths.map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })),
  );
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { cloneCurrentProjectDocument } = await server.ssrLoadModule(
      "/src/core/project/project-schema.ts",
    );
    const { mixCompositionAudio, audibleCompositionLayers } = await server.ssrLoadModule(
      "/src/core/audio/audio-mixer.ts",
    );
    const { buildAudioAnalysisFrame } = await server.ssrLoadModule(
      "/src/core/audio/audio-analysis-frame.ts",
    );
    const base = cloneCurrentProjectDocument(JSON.parse(await readFile(join(root, paths.at(-1)))));
    let state = 0xa57e17d;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const pcm = [8000, 44100, 48000].map((sampleRate, index) => ({
      sampleRate,
      channels: Array.from({ length: index + 1 }, (_, channel) =>
        Array.from(
          new Float32Array(
            Array.from(
              { length: Math.ceil(sampleRate * 0.09) },
              (_, i) => Math.sin(i * (channel + 1) * 0.12) * 0.6 + (random() - 0.5) * 0.3,
            ),
          ),
        ),
      ),
    }));
    const cases = [];
    for (let variant = 0; variant < 32; variant++) {
      const project = structuredClone(base),
        composition = project.compositions[0],
        seed = composition.layers.find((l) => l.kind === "audio");
      composition.duration = 0.12;
      composition.layers = Array.from({ length: 4 }, (_, i) => {
        const layer = structuredClone(seed);
        layer.id = `audio-mix-layer-${i}`;
        layer.sourceId = `audio-mix-source-${i % 3}`;
        layer.kind = i < 2 ? "audio" : "video";
        layer.inPoint = i * 0.007;
        layer.outPoint = 0.1 - i * 0.005;
        layer.timeOffset = (variant % 3) * 0.005;
        layer.timeStretch = [0.3, 1, 2.7][variant % 3];
        if (variant % 7 === 0) layer.timeRemap = { mode: "static", value: 0.018 };
        layer.audio = {
          levelsDb: [[-192, -12, 0, 24][variant % 4], [-9, 0, 18][i % 3]],
          pan: [-1, -0.2, 0, 1][(variant + i) % 4],
          muted: variant % 11 === 0 && i === 0,
          reversed: variant % 2 === 1,
        };
        layer.audioEnabled = !(variant % 13 === 0 && i === 1);
        layer.solo = ((variant & 4) !== 0 && i === 1) || ((variant & 8) !== 0 && i === 3);
        return layer;
      });
      project.sources = pcm.map((data, i) => ({
        ...base.sources[0],
        id: `audio-mix-source-${i}`,
        kind: i === 2 ? "video" : "audio",
        duration: 0.08 + i * 0.015,
        audio: i === 2 ? { channels: 3, sampleRate: data.sampleRate, streamIndex: 0 } : undefined,
      }));
      const decoded = new Map(
        pcm.map((p, i) => [
          `audio-mix-source-${i}`,
          { sampleRate: p.sampleRate, channels: p.channels.map((c) => new Float32Array(c)) },
        ]),
      );
      const mixes = [];
      for (const clipProtection of ["normalize", "limit", "none"])
        for (const startTime of [0, 0.013, 0.085]) {
          const request = {
            startTime,
            endTime: Math.min(0.12, startTime + 0.023),
            sampleRate: [8000, 44100, 48000][variant % 3],
            masterLevelDb: variant % 5 === 0 ? 12 : 0,
            clipProtection,
          };
          const mixed = mixCompositionAudio(project, composition, decoded, request);
          mixes.push({
            request,
            expected: {
              samples: Array.from(mixed.samples),
              sampleRate: mixed.sampleRate,
              frameCount: mixed.frameCount,
              peak: mixed.peak,
              protectionGain: mixed.protectionGain,
            },
          });
        }
      const windows = [-32, 0, 37, 4200, 5800].map((start) => {
        const data = new Float32Array(96),
          first = Math.max(0, start),
          last = Math.min(Math.floor(composition.duration * 48000), start + data.length);
        if (last > first) {
          const mixed = mixCompositionAudio(project, composition, decoded, {
            startTime: first / 48000,
            endTime: last / 48000,
            sampleRate: 48000,
            clipProtection: "none",
          });
          for (let f = 0; f < Math.min(mixed.frameCount, last - first); f++)
            data[first - start + f] = (mixed.samples[f * 2] + mixed.samples[f * 2 + 1]) * 0.5;
        }
        return { start, data: Array.from(data) };
      });
      const frames = [];
      if (variant < 4) {
        const read = (start, length) => {
          const data = new Float32Array(length),
            first = Math.max(0, start),
            last = Math.min(Math.floor(composition.duration * 48000), start + length);
          if (last > first) {
            const mixed = mixCompositionAudio(project, composition, decoded, {
              startTime: first / 48000,
              endTime: last / 48000,
              sampleRate: 48000,
              clipProtection: "none",
            });
            for (let f = 0; f < Math.min(mixed.frameCount, last - first); f++)
              data[first - start + f] = (mixed.samples[f * 2] + mixed.samples[f * 2 + 1]) * 0.5;
          }
          return data;
        };
        for (const time of [0, 0.02, 0.105]) {
          const data = buildAudioAnalysisFrame(read, time);
          frames.push({
            time,
            header: Array.from(new Uint32Array(data.buffer, 0, 4)),
            data: Array.from(data.subarray(4)),
          });
        }
      }
      cases.push({
        id: `mix-${variant}`,
        project,
        composition: composition.id,
        sourceIds: [
          ...new Set(audibleCompositionLayers(composition).map((l) => l.sourceId)),
        ].sort(),
        mixes,
        windows,
        frames,
      });
    }
    await writeAtomicJson(output, { sources, pcm, cases });
    return {
      cases: cases.length,
      mixes: cases.reduce((n, c) => n + c.mixes.length, 0),
      windows: cases.reduce((n, c) => n + c.windows.length, 0),
      frames: cases.reduce((n, c) => n + c.frames.length, 0),
    };
  } finally {
    await server.close();
  }
}
