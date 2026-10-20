import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureAudioSourceOracle(root, output) {
  const paths = [
    "scripts/migration/native-audio-source-oracle.mjs",
    "src/core/project/project-schema.ts",
    "src/core/audio/audio-mixer.ts",
    "src/core/audio/audio-analysis-frame.ts",
    "src/core/audio/audio-analysis-provider.ts",
    "build/ffmpeg/ffmpeg.exe",
    "build/ffmpeg/ffprobe.exe",
  ];
  const sources = await Promise.all(
    paths.map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })),
  );
  const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
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
    const { mixCompositionAudio } = await server.ssrLoadModule("/src/core/audio/audio-mixer.ts");
    const { buildAudioAnalysisFrame } = await server.ssrLoadModule(
      "/src/core/audio/audio-analysis-frame.ts",
    );
    const cases = [];
    for (const item of corpus.cases.filter(
      (c) => c.id === "media-audio" || c.id.startsWith("scene-audio-spectrum-"),
    )) {
      const bytes = await readFile(join(root, item.project)),
        project = cloneCurrentProjectDocument(JSON.parse(bytes)),
        composition = project.compositions.find((c) => c.id === item.composition),
        decoded = new Map();
      for (const source of project.sources.filter((s) => s.kind === "audio")) {
        const entry = project.mediaImports.entries.find((e) => e.sourceId === source.id),
          payload = project.mediaImports.payloads.find((p) => p.id === entry.payloadId);
        assert.equal(payload.storage.kind, "inline");
        const wav = Buffer.from(payload.storage.data, "base64");
        assert.equal(wav.toString("ascii", 0, 4), "RIFF");
        assert.equal(wav.toString("ascii", 8, 12), "WAVE");
        let format, data;
        for (let offset = 12; offset + 8 <= wav.length; ) {
          const size = wav.readUInt32LE(offset + 4),
            end = offset + 8 + size;
          assert(end <= wav.length);
          const kind = wav.toString("ascii", offset, offset + 4);
          if (kind === "fmt ") format = wav.subarray(offset + 8, end);
          if (kind === "data") data = wav.subarray(offset + 8, end);
          offset = end + (size % 2);
        }
        assert(format && data);
        assert.equal(format.readUInt16LE(0), 1);
        assert.equal(format.readUInt16LE(14), 16);
        const count = format.readUInt16LE(2),
          sampleRate = format.readUInt32LE(4);
        assert.equal(sampleRate, 48000);
        assert.equal(data.length % (count * 2), 0);
        const channels = Array.from({ length: count }, (_, channel) =>
          Float32Array.from({ length: data.length / count / 2 }, (_, i) => {
            const sample = data.readInt16LE((i * count + channel) * 2);
            return sample * Math.fround(1 / (sample > 0 ? 32767 : 32768));
          }),
        );
        decoded.set(source.id, { sampleRate, channels });
      }
      const read = (start, length) => {
        const output = new Float32Array(length),
          first = Math.max(0, start),
          last = Math.min(Math.floor(composition.duration * 48000), start + length);
        if (last > first) {
          const mixed = mixCompositionAudio(project, composition, decoded, {
            startTime: first / 48000,
            endTime: last / 48000,
            sampleRate: 48000,
            clipProtection: "none",
          });
          for (let i = 0; i < Math.min(mixed.frameCount, last - first); i++)
            output[first - start + i] = (mixed.samples[i * 2] + mixed.samples[i * 2 + 1]) * 0.5;
        }
        return output;
      };
      const samples = [];
      for (const time of [0, 0.125, 0.731, composition.duration - 0.001]) {
        const request = {
            startTime: time,
            endTime: Math.min(composition.duration, time + 0.004),
            sampleRate: 48000,
            masterLevelDb: 0,
            clipProtection: "limit",
          },
          mixed = mixCompositionAudio(project, composition, decoded, request),
          analysis = buildAudioAnalysisFrame(read, time);
        samples.push({
          time,
          request,
          mix: {
            samples: Array.from(mixed.samples),
            sampleRate: mixed.sampleRate,
            frameCount: mixed.frameCount,
            peak: mixed.peak,
            protectionGain: mixed.protectionGain,
          },
          header: Array.from(new Uint32Array(analysis.buffer, 0, 4)),
          analysis: Array.from(analysis.subarray(4)),
        });
      }
      cases.push({
        id: item.id,
        project: { path: item.project, sha256: sha256(bytes) },
        composition: item.composition,
        sources: decoded.size,
        samples,
      });
    }
    assert.equal(cases.length, 4);
    await writeAtomicJson(output, { sources, cases });
    return {
      cases: cases.length,
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
      decode: "native-ffmpeg-pcm16-versus-exact-wave-samples",
    };
  } finally {
    await server.close();
  }
}
