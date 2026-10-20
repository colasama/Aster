import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createServer } from "vite";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** The CLI consumes authored projects and resource observations, never supplied scene plans. */
export async function auditNativePlanCli(context, oraclePath, sourceCli, execute = runStep) {
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  const oracleFile = await reader.bytes(local(oraclePath));
  const oracle = JSON.parse(oracleFile.bytes);
  for (const source of oracle.sources)
    assert.equal((await reader.bytes(source.path)).sha256, source.sha256);
  const root = join(context.output, "native-project-cli");
  await mkdir(root, { recursive: true });
  const cli = join(
    root,
    process.platform === "win32" ? "aster-render-cli.exe" : "aster-render-cli",
  );
  await copyFile(sourceCli, cli);
  const binary = await reader.bytes(local(cli));
  const server = await createServer({
    root: context.root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  const results = [],
    steps = [],
    fixtures = [];
  async function command(id, args, expected = 0) {
    const step = await execute({ id: `native-project-cli-${id}`, file: cli, args }, context);
    steps.push(step);
    assert.equal(step.exit_code, expected, id);
    assert.equal(step.status, expected === 0 ? "passed" : "failed", id);
    assert(!step.error && !step.signal);
    const log = (await reader.bytes(step.log)).bytes.toString("utf8");
    const lines = log.split(/\r?\n/).filter((l) => l.startsWith("{"));
    assert.equal(lines.length, 1, id);
    return JSON.parse(lines[0]);
  }
  try {
    const { decodeFramePlan } = await server.ssrLoadModule("/src/renderer/frame-plan/codec.ts");
    for (const [index, c] of oracle.cases.entries()) {
      // Root ready invocations carry their exact binary digest in the expected bundle.
      // Unavailable and recursive invocation observations have a separate component oracle.
      if (c.realization_order.length && (!c.generator_available || c.realization_order.length > 1))
        continue;
      const selected = c.outputs[index % c.outputs.length];
      const directory = join(root, `case-${index}`),
        out = join(directory, "out");
      await mkdir(join(directory, "inputs"), { recursive: true });
      const packetMap = new Map(
        [...c.packets, ...c.pixels.map((p) => p.pixels)].map((p) => [p.message.hash, p]),
      );
      for (const packet of packetMap.values())
        await writeFile(
          join(directory, "inputs", `${packet.message.hash}.bin`),
          Uint8Array.from(packet.bytes),
        );
      const records = selected.bundle.plan.metadata.slices[0].generators;
      const request = {
        frame: c.request,
        scene: {
          visualization: selected.context.visualization,
          textBounds: {},
          motionTextBounds: {},
          textLayouts: {},
          locale: "en-US",
        },
        output: selected.context,
        surface: {
          revision: c.surface_revision,
          maxTextureDimension: 8192,
          memoryBudgetMb: 256,
          renderScale: 1,
        },
        generator_device: {
          memoryBudgetMb: 256,
          storageByteLimit: 134217728,
          dispatchWorkgroupLimit: 65535,
        },
        effect_mip_levels: 4,
        shadow_map_size: c.shadow_map_size,
        media: c.media,
        pixels: c.pixels.map((p) => ({ frame: p.frame, pixels: p.pixels.message.hash })),
        generators: c.realization_order.length
          ? [{ definition: oracle.generator_definition, source: oracle.generator_source }]
          : [],
        generator_observations: records.map((r) => ({
          plan_sha256: selected.bundle.resources.find((p) => p.message.hash === r.plan)
            .payload_sha256,
          execution: r.execution,
        })),
      };
      await writeAtomicJson(join(directory, "project.json"), c.project);
      await writeAtomicJson(join(directory, "request.json"), request);
      await writeAtomicJson(
        join(directory, "resources.json"),
        [...packetMap.values()].map((p) => p.message),
      );
      const args = [
        "plan-project",
        "--project",
        join(directory, "project.json"),
        "--request",
        join(directory, "request.json"),
        "--resources",
        join(directory, "inputs"),
        "--resource-manifest",
        join(directory, "resources.json"),
        "--out",
        out,
      ];
      const result = await command(`case-${index}`, args);
      const bytes = (await reader.bytes(local(join(out, "plan.fpln")))).bytes;
      const actual = decodeFramePlan(new Uint8Array(bytes));
      assert.deepEqual(actual.metadata, selected.bundle.plan.metadata, `metadata ${index}`);
      assert.deepEqual(
        actual.blobs.map((b) => Array.from(b)),
        selected.bundle.plan.blobs,
        `bytes ${index}`,
      );
      const manifest = JSON.parse((await reader.bytes(local(join(out, "resources.json")))).bytes);
      assert.deepEqual(
        manifest,
        selected.bundle.resources.map((p) => p.message),
        `resources ${index}`,
      );
      for (const expected of selected.bundle.resources) {
        const payload = await reader.bytes(
          local(join(out, "resources", `${expected.message.hash}.bin`)),
        );
        assert.equal(payload.sha256, expected.payload_sha256);
        assert.equal(payload.bytes.length, expected.byte_length);
      }
      assert.equal(result.kind, "native_project_plan");
      assert.equal(result.project_sha256, sha256(await readFile(join(directory, "project.json"))));
      assert.equal(result.request_sha256, sha256(await readFile(join(directory, "request.json"))));
      assert.equal(result.plan_sha256, sha256(bytes));
      assert.deepEqual(JSON.parse(await readFile(join(out, "report.json"))), result);
      results.push({ case: index, output: local(out), ...result });
      fixtures.push({ directory, out, args, request, packets: [...packetMap.values()] });
    }
    assert.equal(results.length, 138);
    const base = fixtures[0];
    const previous = await readFile(join(base.out, "plan.fpln"));
    await command("reject-existing-output", base.args, 2);
    assert.deepEqual(await readFile(join(base.out, "plan.fpln")), previous);
    for (const kind of ["revision", "time", "observation", "budget", "capacity", "payload"]) {
      const source =
        kind === "capacity"
          ? fixtures.find((f) => f.request.generator_observations.length)
          : kind === "payload"
            ? fixtures.find((f) => f.packets.some((p) => p.bytes.length))
            : base;
      const request = structuredClone(source.request),
        path = join(source.directory, `reject-${kind}.json`),
        out = join(source.directory, `reject-${kind}`);
      if (kind === "revision") request.surface.revision = Number.MAX_SAFE_INTEGER + 1;
      if (kind === "time") request.frame.time = null;
      if (kind === "observation")
        request.generator_observations = [
          { plan_sha256: "a".repeat(64), execution: { status: "unavailable" } },
        ];
      if (kind === "capacity") request.generator_observations[0].execution.capacity++;
      let invalidPayloads;
      if (kind === "payload") {
        invalidPayloads = join(source.directory, "invalid-payloads");
        await mkdir(invalidPayloads);
        for (const original of source.packets)
          await writeFile(
            join(invalidPayloads, `${original.message.hash}.bin`),
            Uint8Array.from(original.bytes),
          );
        const packet = source.packets.find((p) => p.bytes.length),
          bytes = Uint8Array.from(packet.bytes);
        bytes[0] ^= 1;
        await writeFile(join(invalidPayloads, `${packet.message.hash}.bin`), bytes);
      }
      await writeAtomicJson(path, request);
      const args = source.args.map((value, i) =>
        source.args[i - 1] === "--out"
          ? out
          : source.args[i - 1] === "--request"
            ? path
            : source.args[i - 1] === "--resources" && invalidPayloads
              ? invalidPayloads
              : value,
      );
      if (kind === "budget") args.push("--max-bundle-bytes", "1");
      const rejected = await command(`reject-${kind}`, args, 2);
      assert.equal(typeof rejected.error, "string");
      assert(!(await readdir(source.directory)).includes(`reject-${kind}`));
      assert(!(await readdir(source.directory)).some((p) => p.startsWith(".aster-project-plan-")));
    }
    return {
      status: "passed",
      scope: "native-project-cli-component-integration",
      whole_project_plan_parity: false,
      binary: { path: local(cli), sha256: binary.sha256 },
      oracle: { path: local(oraclePath), sha256: oracleFile.sha256 },
      results,
      steps,
      checked_files: await reader.stable(),
    };
  } finally {
    await server.close();
  }
}
