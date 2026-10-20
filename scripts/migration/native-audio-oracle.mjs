import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureAudioOracle(root, output) {
  const sources = await Promise.all(
    [
      "src/core/audio/audio-analysis.ts",
      "src/core/audio/audio-analysis-frame.ts",
      "shaders/audio/analysis-abi.wgsl",
      "scripts/migration/native-audio-oracle.mjs",
    ].map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })),
  );
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const runtime = await server.ssrLoadModule("/src/core/audio/audio-analysis.ts");
    const frame = await server.ssrLoadModule("/src/core/audio/audio-analysis-frame.ts");
    let state = 0xa57e9013;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const inputs = [
      [],
      Array(17).fill(0),
      [1, ...Array(511).fill(0)],
      Array.from(
        { length: 15000 },
        (_, i) => 0.45 * Math.sin((i * 2 * Math.PI * 440) / 48000) + 0.1 * (random() * 2 - 1),
      ),
      Array.from({ length: 4096 }, () => random() * 4 - 2),
    ];
    const pcm = inputs.map((s) => Array.from(new Float32Array(s)));
    const spectra = [],
      peaks = [],
      volumes = [],
      frames = [];
    for (const [input, samples] of pcm.entries()) {
      const data = new Float32Array(samples);
      for (const window of ["blackman", "hamming", "hann", "rectangular"])
        for (const fftSize of [2, 16, 2048, 4096])
          for (const startSample of [0, 7]) {
            spectra.push({
              input,
              fftSize,
              window,
              startSample,
              rate: 48000,
              data: Array.from(
                runtime.analyzeSpectrum(data, 48000, { fftSize, window, startSample }),
              ),
            });
          }
      for (const bins of [1, 7, 32])
        peaks.push({ input, bins, data: Array.from(runtime.buildWaveformPeaks(data, bins)) });
      for (const gain of [-1, 0, 0.25, 1, 4, 10])
        for (const muted of [false, true])
          volumes.push({
            input,
            gain,
            muted,
            data: Array.from(runtime.applyAudioVolume(data, { gain, muted })),
          });
      const read = (start, length) => Float32Array.from({ length }, (_, i) => data[start + i] ?? 0);
      for (const time of [-0.1, -1 / 96000, 0, 0.015, 0.1, 0.25, 0.5])
        for (const present of [false, true]) {
          const flags = 2;
          const result = frame.buildAudioAnalysisFrame(present ? read : undefined, time, { flags });
          frames.push({
            input,
            time,
            present,
            flags,
            header: Array.from(new Uint32Array(result.buffer, 0, 4)),
            data: Array.from(result.subarray(4)),
          });
        }
    }
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    await writeAtomicJson(output, { version: 1, sources, pcm, spectra, peaks, volumes, frames });
    return {
      pcm_inputs: pcm.length,
      spectrum_samples: spectra.length,
      waveform_samples: peaks.length,
      volume_samples: volumes.length,
      analysis_frames: frames.length,
    };
  } finally {
    await server.close();
  }
}
