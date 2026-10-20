import { AudioAnalysisProvider } from "../../src/core/audio/audio-analysis-provider";
import { audibleCompositionLayers, mixCompositionAudio } from "../../src/core/audio/audio-mixer";
import { cloneCurrentProjectDocument } from "../../src/core/project/project-schema";

window.captureProjectAudio = async (root) => {
  const fs = window.require("node:fs");
  const path = window.require("node:path");
  const crypto = window.require("node:crypto");
  const projectPath = path.join(root, "project.json");
  const projectBytes = fs.readFileSync(projectPath);
  const project = cloneCurrentProjectDocument(JSON.parse(projectBytes.toString("utf8")));
  const context = new OfflineAudioContext(2, 1, 48000);
  const proof = (path, bytes) => ({
    path,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
  const sources = [proof(projectPath, projectBytes)];
  const decoded = new Map();
  const decode = async (source) => {
    if (decoded.has(source.id)) return decoded.get(source.id);
    const entry = project.mediaImports.entries.find((e) => e.sourceId === source.id);
    const payload = entry && project.mediaImports.payloads.find((p) => p.id === entry.payloadId);
    if (payload && payload.storage.kind !== "relative")
      throw Error("owner relative source required");
    const file = path.resolve(root, payload?.storage.relativePath ?? source.relativePath);
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep))
      throw Error("source outside owner project");
    const bytes = fs.readFileSync(file);
    sources.push(proof(file, bytes));
    const buffer = await context.decodeAudioData(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const result = {
      sampleRate: buffer.sampleRate,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)),
    };
    decoded.set(source.id, result);
    return result;
  };
  const cases = [];
  for (const composition of project.compositions.filter(
    (c) => audibleCompositionLayers(c).length,
  )) {
    decoded.clear();
    for (const layer of audibleCompositionLayers(composition)) {
      const source = project.sources.find((s) => s.id === layer.sourceId);
      if (source && (source.kind === "audio" || (source.kind === "video" && source.audio)))
        await decode(source);
    }
    const provider = new AudioAnalysisProvider(() => {}, decode);
    provider.frame(project, composition, 0);
    await provider.waitForFrameResources(120000);
    const samples = [];
    for (const time of [0, 0.1, 12, 26, 40, 53, 60, 120, 200, 300, 400, 500].filter(
      (t) => t < composition.duration,
    )) {
      const request = {
        startTime: time,
        endTime: Math.min(composition.duration, time + 0.004),
        sampleRate: 48000,
        masterLevelDb: 0,
        clipProtection: "limit",
      };
      const mix = mixCompositionAudio(project, composition, decoded, request);
      const analysis = provider.frame(project, composition, time);
      samples.push({
        time,
        request,
        mix: {
          samples: Array.from(mix.samples),
          sampleRate: mix.sampleRate,
          frameCount: mix.frameCount,
          peak: mix.peak,
          protectionGain: mix.protectionGain,
        },
        header: Array.from(new Uint32Array(analysis.buffer, 0, 4)),
        analysis: Array.from(analysis.subarray(4)),
      });
    }
    cases.push({
      id: "owner-audio",
      project: proof(projectPath, projectBytes),
      composition: composition.id,
      sources: decoded.size,
      samples,
    });
  }
  return { sources, cases };
};
