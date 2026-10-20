import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createServer } from "vite";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function auditNativePlanDiff(context, generation, execute = runStep) {
  const root = join(context.output, "native-plan-diff");
  await mkdir(root, { recursive: true });
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  const reader = new M0Evidence(context.root);
  const cli = join(
    root,
    process.platform === "win32" ? "aster-render-cli.exe" : "aster-render-cli",
  );
  await copyFile(join(context.root, generation.binary.path), cli);
  const binary = await reader.bytes(local(cli));
  const server = await createServer({
    root: context.root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  const checks = [];
  try {
    const { decodeFramePlan, encodeFramePlan } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/codec.ts",
    );
    const { contentResourceHashSync } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/resources.ts",
    );
    async function capture(result) {
      const directory = join(context.root, result.output);
      const plan = decodeFramePlan(
        new Uint8Array((await reader.bytes(local(join(directory, "plan.fpln")))).bytes),
      );
      const messages = JSON.parse(
        (await reader.bytes(local(join(directory, "resources.json")))).bytes,
      );
      const packets = new Map();
      for (const message of messages)
        packets.set(message.hash, {
          message,
          bytes: new Uint8Array(
            (await reader.bytes(local(join(directory, "resources", `${message.hash}.bin`)))).bytes,
          ),
        });
      return { directory, plan, packets };
    }
    const base = await capture(generation.results.find((r) => r.case === 0));
    const surface = await capture(generation.results.find((r) => r.case === 54));
    const generator = await capture(generation.results.find((r) => r.case === 75));
    const media = await capture(generation.results.find((r) => r.case === 132));
    const remap = (value, map) => {
      if (typeof value === "string") return map.get(value) ?? value;
      if (Array.isArray(value)) return value.map((v) => remap(v, map));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            k === "resources" ? remap(v, map).sort() : remap(v, map),
          ]),
        );
      return value;
    };
    async function candidate(name, source, kind, mutate) {
      const plan = structuredClone(source.plan),
        packets = new Map(source.packets),
        map = new Map();
      const put = (old, metadata, blobs) => {
        const bytes = encodeFramePlan(metadata, blobs),
          descriptor = {
            element_type: "u8",
            element_count: bytes.length,
            byte_length: bytes.length,
          };
        const content = { kind: "buffer", descriptor },
          hash = contentResourceHashSync(content, bytes);
        packets.delete(old);
        packets.set(hash, { message: { type: "put_resource", ...content, hash }, bytes });
        map.set(old, hash);
      };
      let parent;
      let target;
      if (kind === "child") {
        parent = decodeFramePlan(packets.get(plan.metadata.slices[0].precompositions).bytes);
        target = parent.metadata.slices[0].scenes[0].scene;
      } else if (kind === "generator") target = plan.metadata.slices[0].generators[0].plan;
      else if (kind !== "envelope") target = plan.metadata.slices[0][kind];
      if (target) {
        const nested = decodeFramePlan(new Uint8Array(packets.get(target).bytes));
        mutate(nested, packets, map);
        put(target, nested.metadata, nested.blobs);
        if (parent)
          put(plan.metadata.slices[0].precompositions, remap(parent.metadata, map), parent.blobs);
      } else mutate(plan, packets, map);
      const metadata = remap(plan.metadata, map);
      const directory = join(root, name);
      await mkdir(join(directory, "resources"), { recursive: true });
      await writeFile(join(directory, "plan.fpln"), encodeFramePlan(metadata, plan.blobs));
      await writeAtomicJson(
        join(directory, "resources.json"),
        [...packets.values()].map((p) => p.message).sort((a, b) => a.hash.localeCompare(b.hash)),
      );
      for (const p of packets.values())
        await writeFile(join(directory, "resources", `${p.message.hash}.bin`), p.bytes);
      return directory;
    }
    async function check(name, a, b, code, extra = []) {
      const step = await execute(
        {
          id: `native-plan-diff-${name}`,
          file: cli,
          args: ["plan-diff", "--a", join(a, "plan.fpln"), "--b", join(b, "plan.fpln"), ...extra],
        },
        context,
      );
      assert.equal(step.exit_code, code, name);
      assert.equal(step.status, code === 0 ? "passed" : "failed");
      assert(!step.error && !step.signal);
      const log = (await reader.bytes(step.log)).bytes.toString("utf8"),
        lines = log.split(/\r?\n/).filter((l) => l.startsWith("{"));
      assert.equal(lines.length, 1);
      const result = JSON.parse(lines[0]);
      if (code !== 2) {
        assert.equal(result.kind, "plan_diff");
        assert.equal(result.equal, code === 0);
      }
      if (code === 1) assert(result.first_difference.path);
      if (code === 2) assert.equal(typeof result.error, "string");
      checks.push({ name, step, result });
      return result;
    }
    await check("identical", base.directory, base.directory, 0);
    for (const [name, source, kind, offset, size, value, code] of [
      ["scene-relative", base, "scene", 12, 4, (v) => v * 1.000005, 0],
      ["scene-excess", base, "scene", 12, 4, (v) => v * 1.001, 1],
      ["root-absolute", base, "root", 0, 8, (v) => v + 0.0000009, 0],
      ["root-excess", base, "root", 0, 8, (v) => v + 0.001, 1],
      ["light-kind", base, "scene", 44, 4, () => 0.0000001, 1],
      ["child-relative", surface, "child", 12, 4, (v) => v * 1.000005, 0],
      ["child-excess", surface, "child", 12, 4, (v) => v * 1.001, 1],
      ["generator-float", generator, "generator", 0, 4, (v) => v * 1.000005, 0],
      ["generator-integer", generator, "generator", 28, 4, () => 0.0000001, 1],
    ]) {
      const directory = await candidate(name, source, kind, (p) => {
        const view = new DataView(p.blobs[0].buffer, p.blobs[0].byteOffset, p.blobs[0].byteLength);
        if (size === 8) view.setFloat64(offset, value(view.getFloat64(offset, true)), true);
        else view.setFloat32(offset, value(view.getFloat32(offset, true)), true);
      });
      const result = await check(name, source.directory, directory, code);
      if (code === 0) {
        assert(result.tolerated_float_differences > 0);
        await check(`${name}-strict`, source.directory, directory, 1, [
          "--relative",
          "0",
          "--absolute",
          "0",
        ]);
      }
      if (code === 1) assert(result.first_difference.path.includes(`/byte/${offset}`));
    }
    const wrongHeader = await candidate("header", base, "envelope", (p) => {
      p.metadata.header.project_revision++;
    });
    assert.equal(
      (await check("header", base.directory, wrongHeader, 1)).first_difference.path,
      "/header/project_revision",
    );
    const wrongRole = await candidate("typed-role", base, "envelope", (p) => {
      p.metadata.slices[0].scene = p.metadata.slices[0].post;
    });
    await check("typed-role", base.directory, wrongRole, 2);
    const raw = await candidate("raw-pixels", media, "envelope", (p, packets, map) => {
      const old = p.metadata.slices[0].media_pixels[0].pixels,
        packet = structuredClone(packets.get(old));
      packet.bytes[0] ^= 1;
      packet.message.hash = contentResourceHashSync(packet.message, packet.bytes);
      packets.delete(old);
      packets.set(packet.message.hash, packet);
      map.set(old, packet.message.hash);
    });
    await check("raw-pixels", media.directory, raw, 1);
    const corrupt = await candidate("corrupt-resource", base, "envelope", () => {});
    const hash = base.plan.metadata.slices[0].scene,
      bytes = new Uint8Array(base.packets.get(hash).bytes);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(join(corrupt, "resources", `${hash}.bin`), bytes);
    await check("corrupt-resource", base.directory, corrupt, 2);
    await check("invalid-tolerance", base.directory, base.directory, 2, ["--relative", "0.001"]);
    await check("bounded-traversal", base.directory, base.directory, 2, ["--max-plans", "1"]);
    return {
      status: "passed",
      scope: "authenticated-recursive-plan-comparison",
      binary: { path: local(cli), sha256: binary.sha256 },
      checks,
      checked_files: await reader.stable(),
    };
  } finally {
    await server.close();
  }
}
