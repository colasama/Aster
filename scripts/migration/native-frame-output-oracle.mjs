/** Exercise the production output coordinator with explicit observed allocation handles. */
export async function frameOutputOracle(server, device) {
  const { planFrameOutput } = await server.ssrLoadModule(
    "/src/renderer/compositing/plan-frame-output.ts",
  );
  const { DepthEffectsRenderer, DEFAULT_DEPTH_EFFECT_SETTINGS } = await server.ssrLoadModule(
    "/src/renderer/effects/depth-effects.ts",
  );
  const { SurfacePostEffectsRenderer } = await server.ssrLoadModule(
    "/src/renderer/effects/surface-post-effects.ts",
  );
  const { compositionMotionBlurSettings, motionBlurInterval } = await server.ssrLoadModule(
    "/src/core/animation/motion-blur.ts",
  );
  const modes = [
    "beauty",
    "linearColor",
    "luminance",
    "alpha",
    "depthFog",
    "depthOfField",
    "selectionIsolation",
    "vectorMotionBlur",
    "normal",
    "objectId",
    "materialId",
    "worldPosition",
    "motionVector",
  ];
  const texture = { createView: () => ({}) };
  const bytes = (plan) =>
    plan ? { metadata: plan.metadata, blobs: plan.blobs.map((b) => Array.from(b)) } : null;
  return function capture(input) {
    const {
      index,
      composition,
      header,
      geometry,
      motion,
      budget,
      renderer,
      media,
      surfaces,
      generators,
    } = input;
    const outputs = [];
    // Every corpus frame exercises one route; the first project covers the route/resource product.
    const choices = index === 0 ? modes : [modes[index % modes.length]];
    for (const visualization of choices)
      for (const flags of index === 0 ? [0, 1, 2, 3, 4, 5, 6, 7] : [index % 8]) {
        const selectedLayerId =
          flags % 3 === 0
            ? "missing-selection"
            : flags % 3 === 1
              ? geometry.batches[0]?.selectionId
              : (input.generatorPlans?.[0]?.selectionId ?? "generator-selection-😀");
        const settings = compositionMotionBlurSettings(composition);
        const eligible =
          settings.enabled &&
          settings.shutterAngle > 0 &&
          geometry.batches.some(
            (b) =>
              b.layer.motionBlur &&
              !["audio", "null", "camera", "light", "adjustment", "generator"].includes(
                b.layer.kind,
              ),
          );
        const requested =
          eligible && ["beauty", "motionVector", "vectorMotionBlur"].includes(visualization);
        const frameMotion = input.projectDriven ? (requested ? motion : undefined) : motion;
        const context = {
          visualization,
          beautyDepthOfField:
            !input.projectDriven && visualization === "beauty" && Boolean(flags & 1),
          beautyMotionBlur:
            visualization === "beauty" && (input.projectDriven ? eligible : Boolean(flags & 2)),
          motionBlurRequested: input.projectDriven ? requested : Boolean(flags & 2),
          selectedLayerId: selectedLayerId ?? null,
          generatorSelectionIds: input.projectDriven ? [] : ["generator-selection-😀"],
          auxiliaryGenerators: generators,
          auxiliaryBudget: budget,
          motionResourcesAvailable: Boolean(flags & 4),
          motionBindingAvailable: Boolean(flags & 1),
          depthSettings: DEFAULT_DEPTH_EFFECT_SETTINGS,
          depthAttachments: {
            scene: true,
            worldPosition: Boolean(flags & 4),
            transparentWorldPosition: false,
            peeledWorldPosition: false,
            frontLayerColor: false,
            peeledLayerColor: false,
            motionBlurSource: false,
          },
          surfaceResourcesAvailable: Boolean(flags & 4),
        };
        const depthEffects = new DepthEffectsRenderer(device, "rgba16float");
        depthEffects.setSettings(context.depthSettings);
        depthEffects.setSources(
          header.render_target.width,
          header.render_target.height,
          texture,
          flags & 4 ? texture : undefined,
        );
        const surfacePostEffects = new SurfacePostEffectsRenderer(device, "rgba16float");
        surfacePostEffects.setSources(
          header.render_target.width,
          header.render_target.height,
          texture,
          texture,
          flags & 4 ? texture : undefined,
        );
        const plans = planFrameOutput({
          header,
          resources: {
            auxiliaryBuffers: renderer,
            precompositionSurfaces: { bindingFor: (id) => (surfaces[id] ? {} : undefined) },
            sceneGenerators: {
              auxiliaryDraw: (g) => (generators.includes(g.instanceId) ? {} : undefined),
            },
            motionBlur: { ready: context.motionResourcesAvailable, outputTexture: texture },
            motionBlurPostBindGroup: context.motionBindingAvailable ? {} : undefined,
            sceneTexture: texture,
            depthEffects,
            surfacePostEffects,
          },
          sceneBuffers: {
            slice: { vertex_count: geometry.data.length / 40 },
            motionVectors: frameMotion,
          },
          sceneBatches: geometry.batches.map((b) => ({
            ...b,
            mediaResourceHash: media[b.instanceId] ?? undefined,
          })),
          sceneGenerators: input.generatorPlans ?? [
            ...generators.map((instanceId) => ({
              instanceId,
              selectionId: "generator-selection-😀",
            })),
            ...(input.projectDriven
              ? []
              : [{ instanceId: "unavailable-generator", selectionId: "generator-selection-😀" }]),
          ],
          mediaBindings: { bindingForHash: (hash) => (hash ? {} : undefined) },
          visualization,
          beautyDepthOfField: context.beautyDepthOfField,
          beautyMotionBlur: context.beautyMotionBlur,
          motionBlurRequested: context.motionBlurRequested,
          motionBlurSettings: settings,
          shutterInterval: motionBlurInterval(
            input.time,
            composition.frameRate.numerator / composition.frameRate.denominator,
            settings,
          ),
          compositionWidth: composition.width,
          selectedLayerId,
        }).plans;
        // Beauty DOF rebinds the actual auxiliary texture set, even when the auxiliary plan clears.
        if (context.beautyDepthOfField) {
          const a = context.depthAttachments;
          a.worldPosition = Boolean(renderer.textures.get("worldPosition"));
          a.transparentWorldPosition = Boolean(renderer.transparentWorldPosition);
          a.peeledWorldPosition = Boolean(renderer.peeledWorldPosition);
          a.frontLayerColor = Boolean(renderer.frontLayerColor);
          a.peeledLayerColor = Boolean(renderer.peeledLayerColor);
        }
        outputs.push({
          ...(input.collectPlan ? { bundle: input.collectPlan(plans, context, frameMotion) } : {}),
          context,
          expected: Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, bytes(p)])),
        });
        depthEffects.destroy();
        surfacePostEffects.destroy();
      }
    return outputs;
  };
}
