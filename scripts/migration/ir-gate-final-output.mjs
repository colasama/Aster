import assert from "node:assert/strict";

export function auditFinalOutput(runtime, fixture, plan) {
  const decoded = runtime.readFinalOutputPlan(plan);
  assert.deepEqual(decoded.route, fixture.output.route);
  assert.equal(decoded.header.aa, fixture.output.aa);
  assert.deepEqual(decoded.clear, { r: 0, g: 0, b: 0, a: 1 });
  const events = [];
  const resources = {
    postPipeline: "post-pipeline",
    postBindGroup: "scene",
    motionBlurPostBindGroup: "motion_blur",
    gpuProfiler: { writes: () => undefined },
    depthEffects: { encode: (_pass, mode) => events.push(["depth", mode]) },
    surfacePostEffects: { encode: (_pass, mode) => events.push(["surface", mode]) },
    bufferVisualizer: { encode: (_pass, mode) => events.push(["visualizer", mode]) },
  };
  let passes = 0;
  const encoder = {
    beginRenderPass: (descriptor) => {
      passes++;
      assert.deepEqual(descriptor.colorAttachments[0].clearValue, decoded.clear);
      assert.equal(
        descriptor.colorAttachments[0].view,
        decoded.header.aa === "off" ? "canvas" : "aa",
      );
      return {
        setPipeline: (p) => assert.equal(p, "post-pipeline"),
        setBindGroup: (_index, source) => events.push(["beauty", source]),
        draw: (n) => assert.equal(n, 3),
        end() {},
      };
    },
  };
  const antiAliasing = {
    plannedView: (mode, width, height) => {
      assert.equal(mode, fixture.output.aa);
      assert.deepEqual({ width, height }, plan.metadata.header.render_target);
      return mode === "off" ? undefined : "aa";
    },
    encode: (_encoder, output) => assert.equal(output, "canvas"),
  };
  const input = { plan, encoder, output: "canvas", antiAliasing, resources };
  runtime.executeFinalOutput(input);
  const route = fixture.output.route;
  assert.deepEqual(events, [[route.kind, route.kind === "beauty" ? route.source : route.mode]]);
  let missingRejected = false;
  if (route.kind === "beauty" && route.source === "motion_blur") {
    resources.motionBlurPostBindGroup = undefined;
    assert.throws(() => runtime.executeFinalOutput(input), { code: "missing_resource" });
    assert.equal(passes, 1);
    missingRejected = true;
  }
  return {
    id: fixture.id,
    exact_route: true,
    supplied_execution: true,
    aa: fixture.output.aa,
    missing_rejected: missingRejected,
  };
}
