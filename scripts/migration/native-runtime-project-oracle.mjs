import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureRuntimeProjectOracle(root, output, projects) {
  const sources = [];
  for (const path of [
    "src/core/project/project-schema.ts",
    "src/core/animation/text-animator-migration.ts",
    "src/core/media/footage-source.ts",
    "src/core/scene/particle-settings.ts",
    "src/core/scene/bundled-particle.ts",
    "scripts/migration/native-runtime-project-oracle.mjs",
  ]) {
    sources.push({ path, sha256: sha256(await readFile(join(root, path))) });
  }
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  await mkdir(dirname(output), { recursive: true });
  try {
    const { cloneCurrentProjectDocument } = await server.ssrLoadModule(
      "/src/core/project/project-schema.ts",
    );
    const { createDefaultParticleSettings } = await server.ssrLoadModule(
      "/src/core/scene/particle-settings.ts",
    );
    const raw = JSON.parse(
      await readFile(join(root, "examples/projects/minimal-golden.aster.json")),
    );
    const cases = [];
    for (let version = 1; version <= 10; version++) {
      const base = structuredClone(raw);
      base.schemaVersion = version;
      const layers = base.compositions[0].layers;
      layers[0].material = { z: 7, 12: 3, a: 2, 2: 5, unknown: { b: 1, a: 2 } };
      if (version <= 1)
        layers.push({
          ...structuredClone(layers[0]),
          id: "legacy-particles",
          kind: "particle",
          particle: createDefaultParticleSettings(),
        });
      if (version <= 3) {
        base.itemFolderIds = { [layers[0].id]: "folder" };
        layers[0].asset = {
          name: "图片",
          mimeType: "image/png",
          width: 32,
          height: 16,
          dataUrl: "data:image/png;base64,AA==",
        };
        layers.push({ ...structuredClone(layers[0]), id: "duplicate", kind: "image" });
        layers.push({
          ...structuredClone(layers[0]),
          id: "video",
          kind: "video",
          audioGain: 0.5,
          asset: {
            name: "video",
            mimeType: "video/mp4",
            width: "0x20",
            height: " 16 ",
            duration: 2,
            relativePath: "asset/video.mp4",
          },
        });
      }
      if (version <= 8) {
        layers.push({
          ...structuredClone(layers[0]),
          id: "camera",
          kind: "camera",
          camera:
            version <= 5
              ? { fieldOfView: 50, projection: "perspective" }
              : { zoom: 1234.5, filmSize: 36, fStop: 2.8 },
          transform: {
            ...structuredClone(layers[0].transform),
            position: [
              { mode: "static", value: 0 },
              { mode: "static", value: 0 },
              {
                mode: "animated",
                keyframes: [
                  { id: "k", time: 0, value: 3, interpolation: "linear" },
                  { id: "k2", time: 1, value: 8, interpolation: "linear" },
                ],
              },
            ],
          },
        });
      }
      if (version <= 7)
        layers.push({
          ...structuredClone(layers[0]),
          id: "text-old",
          kind: "text",
          textAnimator: {
            enabled: true,
            delay: 0.002,
            stagger: 0.04,
            duration: 0.5,
            position: [15, 32],
            scale: 80,
            opacity: 0,
          },
        });
      cases.push({ id: `schema-${version}`, value: base });
    }
    for (const [id, value] of [
      ["zero", 0],
      ["future", 11],
      ["fractional", 1.5],
      ["string", "10"],
      ["negative", -1],
    ])
      cases.push({ id: `invalid-${id}`, value: { ...structuredClone(raw), schemaVersion: value } });
    for (const [id, mutate] of [
      [
        "particle-extra",
        (p) => {
          p.extra = 1;
        },
      ],
      [
        "particle-range",
        (p) => {
          p.count = 0;
        },
      ],
      [
        "particle-missing",
        (p) => {
          delete p.seed;
        },
      ],
      [
        "particle-vector",
        (p) => {
          p.velocity = [1, 2];
        },
      ],
    ]) {
      const base = structuredClone(raw);
      const particle = createDefaultParticleSettings();
      mutate(particle);
      base.compositions[0].layers[0].kind = "particle";
      base.compositions[0].layers[0].particle = particle;
      cases.push({ id, value: base });
    }

    const collision = structuredClone(raw);
    collision.schemaVersion = 3;
    const collisionLayer = collision.compositions[0].layers[0];
    collision.compositions[0].layers = Array.from({ length: 128 }, (_, index) => ({
      ...structuredClone(collisionLayer),
      id: `collision-${index}`,
      kind: "image",
      asset: { name: `image-${index}`, mimeType: "image/png", width: 32, height: 16 },
    }));
    cases.push({ id: "legacy-source-id-collision", value: collision });
    const canonical = (value) =>
      Array.isArray(value)
        ? `[${value.map(canonical).join(",")}]`
        : value !== null && typeof value === "object"
          ? `{${Object.keys(value)
              .sort()
              .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
              .join(",")}}`
          : JSON.stringify(value);
    const results = [];
    for (const entry of cases) {
      let expected,
        rejected = false;
      try {
        expected = cloneCurrentProjectDocument(entry.value);
        expected.folders ??= [];
        expected.itemFolderIds ??= {};
      } catch {
        rejected = true;
      }
      results.push({ id: entry.id, input: JSON.stringify(entry.value), expected, rejected });
    }
    for (const project of projects) {
      const path = isAbsolute(project.path) ? project.path : join(root, project.path);
      const bytes = await readFile(path);
      if (sha256(bytes) !== project.sha256) throw new Error("Runtime project input changed");
      const expected = cloneCurrentProjectDocument(JSON.parse(bytes));
      expected.folders ??= [];
      expected.itemFolderIds ??= {};
      results.push({
        id: project.cases[0],
        project: { path, sha256: project.sha256 },
        expected_sha256: sha256(Buffer.from(canonical(expected))),
        rejected: false,
      });
    }
    await writeAtomicJson(output, {
      schema_version: 1,
      sources,
      cases: results,
      projects: projects.length,
    });
    return {
      cases: results.length,
      projects: projects.length,
      negative_cases: results.filter((r) => r.rejected).length,
    };
  } finally {
    await server.close();
  }
}
