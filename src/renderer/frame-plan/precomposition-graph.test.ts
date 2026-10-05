import { describe, expect, it } from "vitest";
import { decodeFramePlan } from "./codec";
import { precompositionGraphFixtures } from "./precomposition-graph-fixture";
import {
  applyPrecompositionGraph,
  buildPrecompositionGraph,
  readPrecompositionGraph,
} from "./precomposition-graph-plan";

describe("precomposition target graph", () => {
  it("round trips child-first shared targets and applies supplied routes independent of scene input order", () => {
    const fixture = precompositionGraphFixtures()[0];
    const graph = readPrecompositionGraph(decodeFramePlan(fixture.bytes));
    expect(graph.nodes[1].drawTargets.filter((id) => id === graph.nodes[0].target.id)).toHaveLength(
      2,
    );
    expect(graph.nodes[1].drawTargets.filter((id) => id === null)).toHaveLength(1);
    expect(graph.bindings.get("root/a")).toBe(graph.bindings.get("root/b"));
    expect(applyPrecompositionGraph(graph, [...fixture.plans].reverse())).toEqual(fixture.plans);
    const changed = structuredClone(graph);
    const index = changed.nodes[1].drawTargets.findIndex((id) => typeof id === "string");
    changed.nodes[1].drawTargets[index] = null;
    const supplied = readPrecompositionGraph(
      buildPrecompositionGraph(fixture.metadata.header, changed.nodes, changed.bindings),
    );
    expect(applyPrecompositionGraph(supplied, fixture.plans)[1].draws[index].texture).toEqual({
      kind: "surface",
      targetId: null,
    });
    expect(() =>
      applyPrecompositionGraph(graph, [
        fixture.plans[0],
        { ...fixture.plans[1], target: { ...fixture.plans[1].target, id: "missing" } },
      ]),
    ).toThrow(expect.objectContaining({ code: "missing_resource" }));
  });
  it("rejects duplicate, missing and cyclic targets and inconsistent allocation accounting", () => {
    const f = precompositionGraphFixtures()[0];
    const invalid = [
      () => {
        const n = structuredClone(f.nodes);
        n[0].drawTargets[0] = n[1].target.id;
        return n;
      },
      () => {
        const n = structuredClone(f.nodes);
        n[1].target.id = n[0].target.id;
        return n;
      },
      () => {
        const n = structuredClone(f.nodes);
        n[0].target.estimatedBytes++;
        return n;
      },
      () => {
        const n = structuredClone(f.nodes);
        n[1].drawTargets[0] = "absent";
        return n;
      },
    ];
    for (const make of invalid)
      expect(() => buildPrecompositionGraph(f.metadata.header, make(), new Map())).toThrow();
    const bytes = fixtureBytes(f.bytes);
    expect(() => decodeFramePlan(bytes)).toThrow(
      expect.objectContaining({ code: "invalid_precomposition" }),
    );
    const empty = precompositionGraphFixtures()[1];
    expect(readPrecompositionGraph(decodeFramePlan(empty.bytes))).toEqual({
      nodes: [],
      bindings: new Map(),
    });
  });
});

function fixtureBytes(input: Uint8Array): Uint8Array {
  const bytes = input.slice(),
    view = new DataView(bytes.buffer);
  view.setUint32(view.getUint32(16, true) + 12, 1, true);
  return bytes;
}
