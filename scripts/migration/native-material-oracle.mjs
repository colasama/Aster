import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureMaterialOracle(root, output, env) {
  const sources = [];
  for (const path of [
    "scripts/migration/native-material-oracle.mjs",
    "src/core/project/project-schema.ts",
    "src/core/scene/scene-evaluation.ts",
    "src/renderer/media/material-textures.ts",
    "src/renderer/media/encoded-texture-upload.ts",
    "src/renderer/media/hdr-texture-resource.ts",
    "tests/parity/assets/normal-textures.json",
  ])
    sources.push({ path, sha256: sha256(await readFile(join(root, path))) });
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
    const { flattenSceneLayers } = await server.ssrLoadModule(
      "/src/core/scene/scene-evaluation.ts",
    );
    const { prepareEncodedTexture } = await server.ssrLoadModule(
      "/src/renderer/media/encoded-texture-upload.ts",
    );
    const { prepareHdrTexture } = await server.ssrLoadModule(
      "/src/renderer/media/hdr-texture-resource.ts",
    );
    const { decodeRadianceHdrForUpload } = await server.ssrLoadModule(
      "/src/core/media/hdr-environment.ts",
    );
    const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
    const fixtures = JSON.parse(
      await readFile(join(root, "tests/parity/assets/normal-textures.json")),
    ).fixtures;
    const decoded = new Map(fixtures.map((f) => [f.message.hash, sha256(Buffer.from(f.rgba))]));
    const inputs = [];
    let normalBase;
    for (const item of corpus.cases) {
      let path =
        item.project === "env:ASTER_PERF_PROJECT"
          ? env.ASTER_PERF_PROJECT
          : join(root, item.project);
      if ((await stat(path)).isDirectory()) path = join(path, "project.json");
      const bytes = await readFile(path),
        project = cloneCurrentProjectDocument(JSON.parse(bytes));
      if (item.id === "scene-lighting-directional") normalBase = { item, project };
      if (
        project.compositions.some(
          (c) =>
            c.environment?.enabled ||
            c.layers.some((l) => l.mesh?.materialTextures?.normal?.dataUrl),
        )
      )
        inputs.push({ item, project, proof: { path, sha256: sha256(bytes) } });
    }
    for (const [index, fixture] of fixtures.entries()) {
      const project = structuredClone(normalBase.project),
        composition = project.compositions.find((c) => c.id === normalBase.item.composition);
      const layer = composition.layers.find((l) => l.kind === "mesh");
      layer.mesh.materialTextures ??= {};
      layer.mesh.materialTextures.normal = {
        mimeType: `image/${fixture.message.descriptor.encoding}`,
        dataUrl: `data:image/${fixture.message.descriptor.encoding};base64,${fixture.encoded}`,
        texCoord: 0,
        scale: 1,
      };
      inputs.push({
        item: { ...normalBase.item, id: `normal-fixture-${index}` },
        project,
        inline: project,
      });
    }
    const packets = new Map(),
      cases = [];
    let state = 0xa57e17d;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const data = async (source) => {
      if (!source.startsWith("data:")) throw new Error("Inline material source required");
      return new Uint8Array(await (await fetch(source)).arrayBuffer());
    };
    for (const input of inputs) {
      const { item, project } = input,
        composition = project.compositions.find((c) => c.id === item.composition);
      const rate = composition.frameRate.numerator / composition.frameRate.denominator;
      const times = [
        ...item.frames.map((f) => f / rate),
        ...Array.from({ length: 64 }, () => random() * composition.duration),
      ];
      const samples = [];
      for (const time of times) {
        const meshes = flattenSceneLayers(composition, project, time).filter(
          (s) => s.layer.kind === "mesh",
        );
        const bindings = { normals: {}, environment: null },
          hashes = new Set();
        for (const scene of meshes) {
          const source = scene.layer.mesh?.materialTextures?.normal?.dataUrl;
          if (!source) continue;
          const packet = await prepareEncodedTexture(new Blob([await data(source)]));
          bindings.normals[scene.resourceInstanceId] = packet.message.hash;
          hashes.add(packet.message.hash);
          packets.set(packet.message.hash, {
            message: {
              hash: packet.message.hash,
              kind: packet.message.kind,
              descriptor: packet.message.descriptor,
            },
            sha256: sha256(packet.bytes),
            decoded_sha256: decoded.get(packet.message.hash) ?? null,
          });
        }
        if (
          meshes.length &&
          composition.environment?.enabled &&
          composition.environment.source.dataUrl
        ) {
          const packet = prepareHdrTexture(
            decodeRadianceHdrForUpload(await data(composition.environment.source.dataUrl)),
          );
          bindings.environment = packet.message.hash;
          hashes.add(packet.message.hash);
          packets.set(packet.message.hash, {
            message: {
              hash: packet.message.hash,
              kind: packet.message.kind,
              descriptor: packet.message.descriptor,
            },
            sha256: sha256(packet.bytes),
            decoded_sha256: null,
          });
        }
        samples.push({ time, bindings, hashes: [...hashes].sort() });
      }
      cases.push({
        id: item.id,
        project: input.proof,
        inline: input.inline,
        composition: item.composition,
        samples,
      });
    }
    await writeAtomicJson(output, { sources, packets: [...packets.values()], cases });
    return {
      cases: cases.length,
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
      resources: packets.size,
    };
  } finally {
    await server.close();
  }
}
