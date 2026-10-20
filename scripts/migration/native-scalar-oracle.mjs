import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { writeAtomicJson } from "./report.mjs";

export async function captureScalarOracle(root, output) {
  const sources = [];
  for (const path of [
    "src/core/animation/timeline.ts",
    "src/core/project/validation/values.ts",
    "scripts/migration/native-scalar-oracle.mjs",
  ]) {
    const sha256 = createHash("sha256")
      .update(await readFile(resolve(root, path)))
      .digest("hex");
    sources.push({ path, sha256 });
  }
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const runtime = await server.ssrLoadModule("/src/core/animation/timeline.ts");
    const validation = await server.ssrLoadModule("/src/core/project/validation/values.ts");
    const seed = 0xa57e9003;
    let state = seed;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const key = (time, value, interpolation = "linear", handles = {}) => ({
      id: `key-${time}`,
      time,
      value,
      interpolation,
      ...handles,
    });
    const animated = (...keyframes) => ({ mode: "animated", keyframes });
    const properties = [
      { mode: "static", value: -4.25 },
      animated(),
      animated(key(1, 7)),
      animated(key(1, -10), key(3, 30), key(5, -50)),
      animated(key(1, 10, "step"), key(2, -20, "step"), key(3, 40)),
      animated(key(0, -30, "bezier"), key(2, 50)),
      animated(key(0, 3, "bezier", { easing: [0, 0, 0, 1] }), key(3, 9)),
      animated(key(0, 3, "bezier", { easing: [1, -2, 1, 3] }), key(3, 9)),
      animated(key(0, 3, "bezier", { easing: [-0.2, 2, 1.2, -1] }), key(3, 9)),
      animated(key(0, -5, "linear", { spatialOut: 80 }), key(2, 20)),
      animated(key(0, -5), key(2, 20, "linear", { spatialIn: -80 })),
      animated(key(0, 0, "bezier", { spatialOut: 100 }), key(1, 1, "linear", { spatialIn: -100 })),
      animated(key(0, 1), key(Number.EPSILON / 2, 4), key(1, 8)),
    ];
    for (let index = 0; index < 128; index += 1) {
      let time = random();
      const keys = [];
      for (let n = 0; n < 2 + (index % 7); n += 1) {
        time += 0.01 + random() * 3;
        const handles = n % 2 ? { spatialIn: random() * 100 - 50 } : {};
        if (index % 3 === 0) handles.spatialOut = random() * 200 - 100;
        if (index % 4 === 0)
          handles.easing = [random(), random() * 4 - 2, random(), random() * 4 - 1];
        keys.push(
          key(time, random() * 2000 - 1000, ["linear", "step", "bezier"][(index + n) % 3], handles),
        );
      }
      properties.push(animated(...keys));
    }
    const cases = properties.map((property, index) => {
      validation.validateAnimatable(property, `cases[${index}]`);
      const keys = property.keyframes ?? [];
      const end = keys.at(-1)?.time ?? 2;
      const times = [-1, 0, end, end + 1];
      for (const item of keys) times.push(item.time - 1e-8, item.time, item.time + 1e-8);
      for (let n = 1; n < keys.length; n += 1) times.push((keys[n - 1].time + keys[n].time) / 2);
      for (let n = 0; n < 64; n += 1) times.push(random() * (end + 2) - 1);
      const samples = [...new Set(times)].map((time) => ({
        time,
        value: runtime.evaluateAnimatable(property, time),
        speed: runtime.evaluateAnimatableSpeed(property, time),
      }));
      for (const sample of samples) assert(Object.values(sample).every(Number.isFinite));
      return { id: `scalar-${index}`, property, samples };
    });
    const invalid = [
      animated(key(-1, 0)),
      animated(key(2, 0), key(1, 0)),
      animated(key(0, 0), key(0, 1)),
      animated({ ...key(0, 0), id: "" }),
      animated(key(0, 0, "smooth")),
      animated(key(0, 0, "linear", { easing: null })),
      animated(key(0, 0, "linear", { spatialIn: null })),
      animated(key(0, 0), { ...key(1, 1), id: "key-0" }),
      animated(...Array.from({ length: 10001 }, (_, index) => key(index, index))),
    ];
    for (const property of invalid)
      assert.throws(() => validation.validateAnimatable(property, "invalid"));
    const transform = {
      position: [properties[3], properties[9], properties[1]],
      rotation: [properties[5], properties[0], properties[7]],
      scale: [properties[2], properties[6], properties[8]],
      anchor: [properties[0], properties[10], properties[11]],
      opacity: animated(key(0, -10), key(1, 120)),
    };
    const transforms = [
      {
        transform,
        samples: [-1, 0, 0.25, 0.5, 0.75, 1, 2, 3, 5, 10].map((time) => ({
          time,
          value: runtime.evaluateTransform(transform, time),
        })),
      },
    ];
    for (const source of sources)
      assert.equal(
        createHash("sha256")
          .update(await readFile(resolve(root, source.path)))
          .digest("hex"),
        source.sha256,
      );
    const report = { version: 1, seed, node: process.version, sources, cases, invalid, transforms };
    await writeAtomicJson(output, report);
    return {
      cases: cases.length,
      samples: cases.reduce((sum, item) => sum + item.samples.length, 0),
      invalid: invalid.length,
      transforms: transforms.length,
      output,
    };
  } finally {
    await server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2], "Usage: node scripts/migration/native-scalar-oracle.mjs <output.json>");
  console.log(JSON.stringify(await captureScalarOracle(process.cwd(), resolve(process.argv[2]))));
}
