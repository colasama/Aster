import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureRadianceOracle(root, output, env) {
  const sources = [];
  for (const path of [
    "scripts/migration/native-radiance-oracle.mjs",
    "src/core/media/hdr-environment.ts",
    "src/core/media/half-float.ts",
    "src/renderer/media/hdr-texture-resource.ts",
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
    const { decodeRadianceHdrForUpload } = await server.ssrLoadModule(
      "/src/core/media/hdr-environment.ts",
    );
    const { prepareHdrTexture } = await server.ssrLoadModule(
      "/src/renderer/media/hdr-texture-resource.ts",
    );
    const cases = [];
    const add = (id, bytes) => {
      let expected = null;
      try {
        const packet = prepareHdrTexture(decodeRadianceHdrForUpload(bytes));
        expected = {
          hash: packet.message.hash,
          sha256: sha256(packet.bytes),
          bytes: packet.bytes.length,
        };
      } catch {}
      cases.push({ id, encoded: Buffer.from(bytes).toString("base64"), expected });
    };
    const flat = (width, height, pixels) =>
      Buffer.concat([
        Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`),
        Buffer.from(pixels),
      ]);
    for (let exponent = 0; exponent <= 255; exponent++) {
      const pixels = [];
      for (let channel = 0; channel <= 255; channel++)
        pixels.push(channel, 255 - channel, channel ^ 0x55, exponent);
      add(`exponent-${exponent}`, flat(256, 1, pixels));
    }
    for (const width of [8, 9, 127, 128, 129, 1024]) {
      const encoded = [2, 2, width >> 8, width & 255];
      for (const value of [32, 96, 255, 129]) {
        let left = width;
        while (left > 0) {
          const count = Math.min(127, left);
          encoded.push(128 + count, value);
          left -= count;
        }
      }
      add(`rle-${width}`, flat(width, 1, encoded));
      for (const count of [0, 128]) {
        const invalid = [...encoded];
        invalid[4] = count;
        add(`rle-${width}-count-${count}`, flat(width, 1, invalid));
      }
      add(`rle-${width}-truncated`, flat(width, 1, encoded.slice(0, -1)));
    }
    const good = flat(1, 1, [128, 64, 32, 129]);
    add("flat", good);
    add("trailing", Buffer.concat([good, Buffer.from([0])]));
    add("truncated", good.subarray(0, good.length - 1));
    add("empty", Buffer.alloc(0));
    for (const header of [
      "#?BAD\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n",
      "#?RGBE\n\n-Y 1 +X 1\n",
      "#?RGBE\nFORMAT=32-bit_rle_rgbe\n\n+Y 1 +X 1\n",
      "#?RGBE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4097 +X 1\n",
    ])
      add(`invalid-header-${cases.length}`, Buffer.from(header));
    const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
    const seen = new Set();
    for (const item of corpus.cases) {
      let path =
        item.project === "env:ASTER_PERF_PROJECT"
          ? env.ASTER_PERF_PROJECT
          : join(root, item.project);
      if ((await stat(path)).isDirectory()) path = join(path, "project.json");
      if (seen.has(path)) continue;
      seen.add(path);
      const bytes = await readFile(path),
        project = JSON.parse(bytes);
      for (const composition of project.compositions) {
        const source = composition.environment?.source.dataUrl;
        if (!source) continue;
        const comma = source.indexOf(",");
        if (comma < 0 || !source.slice(0, comma).endsWith(";base64"))
          throw new Error("Unsupported environment data URL");
        const payload = Buffer.from(source.slice(comma + 1), "base64");
        add(`${item.id}/${composition.id}`, payload);
        sources.push({ path, sha256: sha256(bytes) });
      }
    }
    await writeAtomicJson(output, { sources, cases });
    return {
      cases: cases.length,
      accepted: cases.filter((c) => c.expected).length,
      rejected: cases.filter((c) => !c.expected).length,
    };
  } finally {
    await server.close();
  }
}
