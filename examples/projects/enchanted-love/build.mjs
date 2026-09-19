import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { actOne } from "./act-one.mjs";
import { actThree } from "./act-three.mjs";
import { actTwo } from "./act-two.mjs";
import { comp, during, instance, layer, place } from "./authoring.mjs";
import { createCharacters } from "./characters.mjs";
import { createProps } from "./props.mjs";
import { sceneBook } from "./scenes.mjs";

const output = resolve(process.argv[2] ?? "artifacts/enchanted-love");
await mkdir(output, { recursive: true });
const props = createProps();
const characters = createCharacters(props);
const book = sceneBook(props, characters);
actOne(book);
actTwo(book);
actThree(book);
const master = comp("Enchanted Love · Master");
master.background = [0.0385, 0.0385, 0.0385, 1];
master.layers = book.shots.map((shot) => {
  const source = book.scenes.find((c) => c.id === shot.composition);
  return during(place(instance(source), 640, 424), shot.start, shot.end);
});
const project = {
  schemaVersion: 10,
  id: "enchanted-love-native",
  name: "Enchanted Love · native rigs",
  activeCompositionId: master.id,
  compositions: [master, ...book.scenes, ...props.assets, ...characters.assets, ...book.supporting],
  sources: [],
  folders: [
    { id: "scenes", name: "01 · Scenes" },
    { id: "characters", name: "02 · Character rigs" },
    { id: "props", name: "03 · Reusable props" },
    { id: "audio", name: "04 · Audio" },
    { id: "supporting", name: "05 · Lighting and colour variants" },
  ],
  itemFolderIds: {},
  commandLog: [],
  updatedAt: "2026-09-19T00:00:00Z",
};
for (const c of props.assets) project.itemFolderIds[c.id] = "props";
for (const c of characters.assets) project.itemFolderIds[c.id] = "characters";
for (const c of book.scenes) project.itemFolderIds[c.id] = "scenes";
for (const c of book.supporting) project.itemFolderIds[c.id] = "supporting";
const audioPath = process.argv[3];
if (audioPath) {
  const data = await readFile(audioPath);
  project.sources.push({
    id: "soundtrack",
    name: "Original stereo soundtrack",
    kind: "audio",
    mimeType: "audio/mp4",
    contentIdentity: `sha256:${createHash("sha256").update(data).digest("hex")}`,
    duration: 130.175833,
    channels: 2,
    sampleRate: 48000,
    streamIndex: 0,
    interpretation: { alpha: "ignore", colorSpace: "srgb" },
    dataUrl: `data:audio/mp4;base64,${data.toString("base64")}`,
  });
  project.itemFolderIds.soundtrack = "audio";
  const audio = layer("Original soundtrack", "audio", 0, 0);
  Object.assign(audio, {
    visible: false,
    sourceId: "soundtrack",
    audioEnabled: true,
    audio: { levelsDb: [0, 0], pan: 0, muted: false, reversed: false },
  });
  master.layers.push(audio);
}
// Aster's layer list is topmost first; the authoring code uses painter order.
for (const composition of project.compositions) composition.layers.reverse();
await writeFile(`${output}/project.json`, JSON.stringify(project, null, 2));
await writeFile(`${output}/shots.json`, JSON.stringify(book.shots, null, 2));
console.log(
  JSON.stringify({
    output,
    compositions: project.compositions.length,
    layers: project.compositions.reduce((n, c) => n + c.layers.length, 0),
  }),
);
