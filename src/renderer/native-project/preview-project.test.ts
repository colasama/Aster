import { expect, test } from "vitest";
import { activeComposition, createDemoProject } from "../../core/project/project";
import { previewProjectClosure } from "./preview-project";

test("preview snapshots retain cyclic nested and future-time dependencies without unrelated assets", () => {
  const project = createDemoProject();
  const root = activeComposition(project);
  const child = structuredClone(root);
  child.id = "nested";
  child.layers[0].sourceCompositionId = root.id;
  root.layers[0].sourceCompositionId = child.id;
  root.layers[0].inPoint = 100;
  const unrelated = structuredClone(root);
  unrelated.id = "unused";
  project.compositions.push(child, unrelated);
  project.itemFolderIds.unused = "folder";
  const result = previewProjectClosure(project, root.id);
  expect(result.compositions.map((c) => c.id)).toEqual([root.id, child.id]);
  expect(result.compositions[0].layers[0].inPoint).toBe(100);
  expect(result.itemFolderIds.unused).toBeUndefined();
  expect(project.compositions).toContain(unrelated);
  expect(() => previewProjectClosure(project, "missing")).toThrow("dependency is missing");
});
