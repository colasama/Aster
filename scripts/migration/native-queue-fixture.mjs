import { createHash } from "node:crypto";

/** Add an audible, deterministic source without changing the visual fixture. */
export function withQueueAudio(manifest) {
  const project = JSON.parse(manifest.projectSnapshot);
  const composition = project.compositions.find((item) => item.id === manifest.compositionId);
  const rate = 48000,
    count = rate * 3;
  const wav = Buffer.alloc(44 + count * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++)
    wav.writeInt16LE(Math.round(8192 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  const id = "queue-tone";
  project.sources.push({
    id,
    kind: "audio",
    name: "Tone.wav",
    mimeType: "audio/wav",
    contentIdentity: `sha256:${createHash("sha256").update(wav).digest("hex")}`,
    dataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
    duration: 3,
    channels: 1,
    sampleRate: rate,
    streamIndex: 0,
    interpretation: { alpha: "ignore", colorSpace: "srgb" },
  });
  const layer = structuredClone(composition.layers[0]);
  Object.assign(layer, {
    id,
    name: "Tone",
    kind: "audio",
    sourceId: id,
    visible: false,
    solo: false,
    audioEnabled: true,
    motionBlur: false,
    audio: { levelsDb: [0, 0], pan: 0, muted: false, reversed: false },
    inPoint: 0,
    outPoint: 3,
    effects: [],
    size: [0, 0],
  });
  delete layer.sourceCompositionId;
  composition.layers.push(layer);
  manifest.projectSnapshot = JSON.stringify(project);
  manifest.outputs[0].includeAudio = true;
  return manifest;
}
