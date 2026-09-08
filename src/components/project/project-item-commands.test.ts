import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import {
  activeComposition,
  createBlankComposition,
  createBlankProject,
} from "../../core/project/project";
import {
  duplicateProjectComposition,
  projectFolderMoveDestinations,
  projectItemDeleteBlock,
} from "./project-item-commands";

describe("project item commands", () => {
  it("duplicates compositions with independent layer, parent, effect, and keyframe identities", () => {
    const project = createBlankProject();
    const composition = activeComposition(project);
    const parent = createLayerForComposition("shape", composition);
    const child = createLayerForComposition("text", composition);
    child.parentId = parent.id;
    parent.transform.position[0] = {
      mode: "animated",
      keyframes: [{ id: crypto.randomUUID(), time: 0, value: 0, interpolation: "linear" }],
    };
    composition.layers = [parent, child];
    const duplicate = duplicateProjectComposition(composition, "Comp Copy");
    expect(duplicate.id).not.toBe(composition.id);
    expect(duplicate.layers.map((layer) => layer.id)).not.toEqual(
      composition.layers.map((layer) => layer.id),
    );
    expect(duplicate.layers[1]?.parentId).toBe(duplicate.layers[0]?.id);
    expect(duplicate.layers[0]?.transform.position[0]).not.toBe(parent.transform.position[0]);
    expect(
      duplicate.layers[0]?.transform.position[0].mode === "animated" &&
        duplicate.layers[0].transform.position[0].keyframes[0]?.id,
    ).not.toBe(
      parent.transform.position[0].mode === "animated"
        ? parent.transform.position[0].keyframes[0]?.id
        : undefined,
    );
  });

  it("explains unsafe deletions for referenced and required items", () => {
    const project = createBlankProject();
    const composition = activeComposition(project);
    expect(
      projectItemDeleteBlock(project, {
        id: composition.id,
        kind: "composition",
        name: composition.name,
      }),
    ).toBe("finalComposition");
    const nested = createBlankComposition("Nested");
    project.compositions.push(nested);
    const precomp = createLayerForComposition("precomposition", composition);
    precomp.sourceCompositionId = nested.id;
    composition.layers.push(precomp);
    expect(
      projectItemDeleteBlock(project, {
        id: nested.id,
        kind: "composition",
        name: nested.name,
      }),
    ).toBe("compositionReferenced");
  });

  it("excludes the current folder and descendants from move destinations", () => {
    const project = createBlankProject();
    const parent = { id: crypto.randomUUID(), name: "Parent" };
    const child = { id: crypto.randomUUID(), name: "Child", parentId: parent.id };
    const sibling = { id: crypto.randomUUID(), name: "Sibling" };
    project.folders = [parent, child, sibling];
    const destinations = projectFolderMoveDestinations(project, {
      id: parent.id,
      kind: "folder",
      name: parent.name,
    });
    expect(destinations.folders).toEqual([sibling]);
    expect(destinations.includeRoot).toBe(false);
  });
});
