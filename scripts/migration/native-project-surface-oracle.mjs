export function projectSurfaceBundle(
  m,
  project,
  layers,
  revision,
  generatorAvailable = true,
  media = {},
  packets = [],
) {
  const prepared = m.evaluatePrecompositionSources({
    project,
    sceneLayers: layers,
    revision,
    maxTextureDimension: 8192,
    memoryBudgetMb: 256,
    enableTextMotionBlur: false,
    renderScale: 1,
  });
  const scenes = [];
  for (const operation of prepared.operations) {
    if (operation.kind !== "scene") continue;
    const source = operation.source,
      geometry = m.evaluatePrecompositionGeometry(source, () => undefined);
    const header = m.buildFrameHeader({
      snapshot: { snapshotScope: "precomposition-effects", projectRevision: revision },
      compositionId: source.composition.id,
      time: source.time,
      frameRate: source.composition.frameRate,
      target: { width: source.composition.width, height: source.composition.height },
      renderTarget: { width: source.target.width, height: source.target.height },
      antiAliasing: "off",
    });
    const effects = m.prepareLayerEffects({
      scene: source.layers,
      composition: source.composition,
      header,
      mipLevelCount: source.target.hasEffects
        ? Math.min(
            8,
            Math.floor(
              Math.log2(
                Math.max(Math.ceil(source.target.width / 2), Math.ceil(source.target.height / 2)),
              ),
            ) + 1,
          )
        : 1,
      planner: new m.LutSelectionPlanner(),
      context: "precomposition",
    });
    const generators = source.layers
      .filter((s) => s.layer.kind === "generator")
      .map((scene) =>
        new m.SceneGeneratorPlanner().prepare({
          scene,
          composition: source.composition,
          definition: m.bundledParticleDefinition,
          width: source.target.width,
          height: source.target.height,
          memoryBudgetMb: 256,
          storageByteLimit: 134217728,
          dispatchWorkgroupLimit: 65535,
          camera: geometry.camera,
        }),
      );
    const scene = m.buildPrecompositionScenePlan({
      target: source.target,
      revision,
      composition: source.composition,
      time: source.time,
      layers: source.layers,
      geometry: geometry.geometry,
      lighting: geometry.lighting,
      effects,
      generators,
      surfaceTargets: prepared.bindings,
    });
    for (const draw of scene.draws)
      if (draw.texture.kind === "media" && !(draw.texture.instanceId in media))
        media[draw.texture.instanceId] = media.$frame ?? null;
    scenes.push(
      m.bindPrecompositionSceneMedia(scene, {
        hashFor: (id) => media[id] ?? null,
        bindingForHash: () => ({}),
      }),
    );
  }
  const realization_order = scenes.flatMap((s) => s.generators.map((g) => g.instanceId));
  for (const scene of scenes)
    for (const generator of scene.generators) {
      const invocation = generator.plan.metadata.slices[0];
      generator.execution = generatorAvailable
        ? {
            status: "ready",
            capacity: invocation.capacity,
            effective_count: invocation.effective_count,
          }
        : { status: "unavailable" };
    }
  if (!scenes.length) return { bindings: {}, bundle: undefined, realization_order };
  const graph = m.buildPrecompositionGraph(
    scenes[0].scene.metadata.header,
    scenes.map((s) => ({
      target: s.target,
      drawTargets: s.draws.map((d) =>
        d.texture.kind === "surface" ? d.texture.targetId : undefined,
      ),
    })),
    prepared.bindings,
  );
  return {
    realization_order,
    bindings: Object.fromEntries(prepared.bindings),
    bundle: m.buildPrecompositionBundle(
      graph,
      scenes,
      packets.map((p) => p.message),
    ),
  };
}
