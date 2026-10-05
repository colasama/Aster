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
    depthEffects: {
      preparePlan: (p) => () =>
        events.push(["depth", runtime.readPostEffectPlan(p).slice.effect.mode]),
    },
    surfacePostEffects: {
      preparePlan: (p) => () =>
        events.push(["surface", runtime.readPostEffectPlan(p).slice.effect.mode]),
    },
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
  const route = fixture.output.route;
  const postEffectPlan =
    route.kind === "depth" || route.kind === "surface"
      ? runtime
          .postEffectFixtures()
          .find(
            (f) =>
              f.postEffect.effect.kind === route.kind && f.postEffect.effect.mode === route.mode,
          ).plan
      : undefined;
  if (postEffectPlan) postEffectPlan.metadata.header = structuredClone(plan.metadata.header);
  const input = { plan, postEffectPlan, encoder, output: "canvas", antiAliasing, resources };
  runtime.executeFinalOutput(input);
  assert.deepEqual(events, [[route.kind, route.kind === "beauty" ? route.source : route.mode]]);
  let missingRejected = false;
  if (postEffectPlan) {
    assert.throws(() => runtime.executeFinalOutput({ ...input, postEffectPlan: undefined }), {
      code: "missing_resource",
    });
    const wrong = structuredClone(postEffectPlan);
    wrong.metadata.header.project_revision++;
    assert.throws(() => runtime.executeFinalOutput({ ...input, postEffectPlan: wrong }), {
      code: "invalid_header",
    });
    assert.equal(passes, 1);
    missingRejected = true;
  }
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
