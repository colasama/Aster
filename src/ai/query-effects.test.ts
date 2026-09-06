import { expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import { AsterAgentApplicationService } from "./application-service";

it("queries effects on unselected layers with stable pagination and no LUT payload", async () => {
  const project = createBlankProject();
  const comp = project.compositions[0];
  const layer = createLayerForComposition("adjustment", comp);
  layer.effects = [
    {
      id: "unselected-lut",
      type: "lut",
      name: "LUT",
      enabled: true,
      parameters: { intensity: 100 },
      resource: {
        kind: "lut3d",
        name: "LUT",
        size: 2,
        data: Array(24).fill(1),
        domainMin: [0, 0, 0],
        domainMax: [1, 1, 1],
        checksum: "12345678",
      },
    },
  ];
  comp.layers.push(layer);
  const service = new AsterAgentApplicationService({
    project,
    projectRevision: 1,
    selection: [comp.layers[0].id],
    currentTime: 0,
    accessMode: "agent",
    primaryModelSupportsImages: false,
  });
  const result = await service.executeTool("query_project", {
    kind: "effects",
    projectRevision: 1,
    limit: 1,
  });
  expect(result).toMatchObject({
    total: 1,
    items: [{ layerId: layer.id, id: "unselected-lut", parameters: { intensity: 100 } }],
  });
  expect(JSON.stringify(result)).not.toContain("resource");
  expect(
    await service.executeTool("query_project", { kind: "effects", projectRevision: 1, offset: 1 }),
  ).toMatchObject({ total: 1, items: [] });
});
