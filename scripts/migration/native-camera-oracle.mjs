import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureCameraOracle(root, output, projectInputs) {
  const sources = [];
  for (const path of [
    "src/core/scene/camera-settings.ts",
    "src/core/scene/camera-properties.ts",
    "src/core/scene/camera-optics.ts",
    "src/core/scene/camera-rig.ts",
    "src/core/scene/scene-evaluation.ts",
    "src/core/animation/expressions.ts",
    "src/core/animation/timeline.ts",
    "scripts/migration/native-camera-oracle.mjs",
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
    const settings = await server.ssrLoadModule("/src/core/scene/camera-settings.ts");
    const rig = await server.ssrLoadModule("/src/core/scene/camera-rig.ts");
    const optics = await server.ssrLoadModule("/src/core/scene/camera-optics.ts");
    const { evaluateWorldTransform } = await server.ssrLoadModule(
      "/src/core/scene/scene-evaluation.ts",
    );
    const cases = [],
      seen = new Set();
    let state = 0xa57e9006;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    function capture(camera, size, samples, defaultCamera = false) {
      const points = [
        [0, 0, 0],
        [size[0] / 2, size[1] / 2, 0],
        [size[0], size[1], 0],
        [10, -25, -100000],
        [5, 5, 1e7],
      ];
      const result = samples.map(({ time, transform }) => {
        const evaluated = defaultCamera
          ? settings.createDefaultEvaluatedCamera(...size)
          : settings.evaluateCameraSettings(
              camera ?? settings.createDefaultCameraSettings(...size),
              transform,
              time,
              size[0],
            );
        const depthSamples = [-1e7, -1000, -10, 0, 10, 1000, 1e7].map((depth) => ({
          camera_depth: evaluated.pose.position[2],
          surface_depth: depth,
          render_width: size[0] * 0.5,
          value: optics.circleOfConfusionRadius(
            evaluated.optics,
            evaluated.pose.position[2],
            depth,
            size[0],
            size[0] * 0.5,
          ),
        }));
        return {
          time,
          transform,
          evaluated,
          basis: rig.evaluateCameraBasis(evaluated.pose),
          projected: points.map((point) =>
            rig.projectCameraPoint(point, evaluated.pose, evaluated.projection, size),
          ),
          depth_samples: depthSamples,
          sample_count: optics.depthOfFieldSampleCount(evaluated.optics.renderQuality),
        };
      });
      cases.push({ camera, size, points, default_camera: defaultCamera, samples: result });
    }
    for (const input of projectInputs) {
      const path = isAbsolute(input.path) ? input.path : join(root, input.path);
      const bytes = await readFile(path);
      assert.equal(sha256(bytes), input.sha256);
      const project = JSON.parse(bytes);
      for (const composition of project.compositions)
        for (const layer of composition.layers) {
          if (layer.kind !== "camera") continue;
          const identity = JSON.stringify([
            composition.width,
            composition.height,
            layer.camera,
            layer.transform,
            layer.expressions,
            layer.parentId,
          ]);
          if (seen.has(identity)) continue;
          seen.add(identity);
          const times = [
            0,
            composition.duration,
            ...Array.from({ length: 64 }, () => random() * composition.duration),
          ];
          capture(
            layer.camera ?? null,
            [composition.width, composition.height],
            times.map((time) => ({
              time,
              transform: evaluateWorldTransform(layer, composition, time),
            })),
          );
        }
    }
    const transform = {
      position: [160, 90, -1000],
      rotation: [0, 0, 0],
      scale: [100, 100, 100],
      anchor: [0, 0, 0],
      opacity: 1,
    };
    for (const size of [
      [320, 180],
      [1920, 1080],
      [1, 1],
      [32768, 32768],
    ])
      capture(null, size, [{ time: 0, transform }], true);
    for (const [index, shape] of [
      "fastRectangle",
      "square",
      "triangle",
      "pentagon",
      "hexagon",
      "heptagon",
      "octagon",
      "nonagon",
      "decagon",
      "circle",
    ].entries()) {
      const camera = settings.createDefaultCameraSettings(320, 180);
      camera.mode = index % 2 ? "oneNode" : "twoNode";
      camera.projection = index % 3 ? "perspective" : "orthographic";
      camera.depthOfField = true;
      camera.lockFocusToZoom = false;
      camera.irisShape = shape;
      camera.focusDistance = { mode: "static", value: 700 };
      camera.zoom = {
        mode: "animated",
        keyframes: [
          { id: "a", time: 0, value: 500, interpolation: "bezier", easing: [0.2, -4, 0.8, 5] },
          { id: "b", time: 2, value: 2000, interpolation: "linear" },
        ],
      };
      camera.orientation[0] = { mode: "static", value: 33 };
      if (index === 0)
        camera.pointOfInterest = transform.position.map((value) => ({ mode: "static", value }));
      if (index === 1)
        camera.pointOfInterest = [160, 1000, -1000].map((value) => ({ mode: "static", value }));
      capture(
        camera,
        [320, 180],
        [0, 0.1, 0.5, 1, 1.5, 2, 3].map((time) => ({
          time,
          transform: { ...transform, rotation: [20, -15, 37] },
        })),
      );
    }
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    for (const input of projectInputs)
      assert.equal(
        sha256(await readFile(isAbsolute(input.path) ? input.path : join(root, input.path))),
        input.sha256,
      );
    await writeAtomicJson(output, { version: 1, sources, cases });
    return {
      cases: cases.length,
      samples: cases.reduce((sum, item) => sum + item.samples.length, 0),
      project_camera_tracks: seen.size,
    };
  } finally {
    await server.close();
  }
}
