import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function auditPrecompositionGraph(runtime, fixture, after, options) {
  const graph = runtime.readPrecompositionGraph(after);
  assert.deepEqual(graph, fixture.graph);
  const applied = runtime.applyPrecompositionGraph(graph, [...fixture.plans].reverse());
  assert.deepEqual(applied, fixture.plans);
  const rejections = [];
  if (graph.nodes.length) {
    assert.equal(graph.nodes.length, 2);
    assert.equal(
      graph.nodes[1].drawTargets.filter((t) => t === graph.nodes[0].target.id).length,
      2,
    );
    assert.equal(graph.nodes[1].drawTargets.filter((t) => t === null).length, 1);
    assert.equal(graph.bindings.get("root/a"), graph.bindings.get("root/b"));
    const changed = structuredClone(graph);
    const index = changed.nodes[1].drawTargets.findIndex((t) => typeof t === "string");
    changed.nodes[1].drawTargets[index] = null;
    const supplied = runtime.readPrecompositionGraph(
      runtime.buildPrecompositionGraph(after.metadata.header, changed.nodes, changed.bindings),
    );
    assert.deepEqual(
      runtime.applyPrecompositionGraph(supplied, fixture.plans)[1].draws[index].texture,
      { kind: "surface", targetId: null },
    );
    assert.throws(
      () =>
        runtime.applyPrecompositionGraph(graph, [
          fixture.plans[0],
          { ...fixture.plans[1], target: { ...fixture.plans[1].target, id: "missing" } },
        ]),
      { code: "missing_resource" },
    );
    const mutations = [
      ["self-reference", null, (view, start) => view.setUint32(start + 16, 2, true)],
      ["forward-reference", null, (view, start) => view.setUint32(start + 16, 3, true)],
      ["routing-count", null, (view, start) => view.setUint32(start + 4, 0, true)],
      [
        "duplicate-target",
        (m) => {
          m.slices[0].targets[1].id = m.slices[0].targets[0].id;
        },
      ],
      [
        "missing-alias-target",
        (m) => {
          m.slices[0].bindings[0].target_index = 2;
        },
      ],
      [
        "cache-accounting",
        (m) => {
          m.slices[0].targets[0].estimated_bytes++;
        },
      ],
    ];
    for (const [id, metadata, payload] of mutations) {
      const bytes = mutate(fixture.bytes, metadata, payload);
      assert.throws(() => runtime.decodeFramePlan(bytes), `TS accepted graph ${id}`);
      const input = join(options.context.output, `precomposition-reject-${id}.fpln`);
      const output = join(options.context.output, `precomposition-reject-${id}.out.fpln`);
      await writeFile(input, bytes, { flag: "wx" });
      const result = await options.command(
        `ir-precomposition-reject-${id}`,
        options.cli,
        ["ir", "roundtrip", "--input", input, "--output", output],
        2,
      );
      const report = options.cliReport(result.log);
      assert.equal(report.code, "invalid_precomposition");
      await assert.rejects(access(output), { code: "ENOENT" });
      rejections.push({ id, code: report.error?.code ?? report.code, log: result.step.log });
    }
  }
  return {
    id: fixture.id,
    exact_targets: true,
    exact_routes: true,
    exact_aliases: true,
    supplied_execution: true,
    targets: graph.nodes.length,
    rejections,
  };
}

function mutate(input, metadata, payload) {
  const old = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const json = JSON.parse(
    Buffer.from(input.subarray(32, 32 + old.getUint32(8, true))).toString("utf8"),
  );
  if (metadata) metadata(json);
  const encoded = Buffer.from(JSON.stringify(json));
  const blob = input.subarray(old.getUint32(16, true));
  const start = Math.ceil((32 + encoded.length) / 16) * 16;
  const bytes = new Uint8Array(start + blob.length);
  bytes.set(input.subarray(0, 32));
  const view = new DataView(bytes.buffer);
  view.setUint32(8, encoded.length, true);
  view.setUint32(16, start, true);
  view.setUint32(20, bytes.length, true);
  bytes.set(encoded, 32);
  bytes.set(blob, start);
  if (payload) payload(view, start);
  return bytes;
}
