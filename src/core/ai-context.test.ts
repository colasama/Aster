import { describe, expect, it } from "vitest";
import {
  buildAiContext,
  MAX_AI_CONTEXT_BYTES,
  queryAssets,
  queryProperties,
  queryScene,
  queryTimeline,
} from "./ai-context";
import { createLayerForComposition } from "./layer-factory";
import { createDemoProject } from "./project";

describe("bounded AI project queries", () => {
  it("exposes selection properties, timeline, and evaluated scene state", () => {
    const project = createDemoProject();
    const composition = project.compositions[0];
    const selected = composition.layers[0];
    const properties = queryProperties(composition, [selected.id], 0.72);
    expect(properties[0]).toMatchObject({ id: selected.id, kind: selected.kind });
    expect(properties[0].properties["position.1"].keyframeTimes.length).toBeGreaterThan(0);
    expect(
      queryTimeline(composition).find((layer) => layer.id === selected.id)?.keyframeCount,
    ).toBe(8);
    expect(queryScene(project, composition, 0.72)[0]).toHaveProperty("instanceId");
  });

  it("reports asset metadata without exposing embedded bytes or paths", () => {
    const project = createDemoProject();
    const composition = project.compositions[0];
    const image = createLayerForComposition("image", composition);
    image.asset = {
      name: "plate.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,PRIVATE_BYTES",
      width: 1920,
      height: 1080,
    };
    composition.layers.push(image);
    const serialized = JSON.stringify(queryAssets(project));
    expect(serialized).toContain("plate.png");
    expect(serialized).not.toContain("PRIVATE_BYTES");
    expect(serialized).not.toContain("dataUrl");
  });

  it("builds a provider context under the fixed transfer budget", () => {
    const project = createDemoProject();
    const selected = project.compositions[0].layers[0].id;
    const context = buildAiContext(project, [selected], 0.72);
    expect(context.schemaVersion).toBe(1);
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThan(
      MAX_AI_CONTEXT_BYTES,
    );
  });
});
