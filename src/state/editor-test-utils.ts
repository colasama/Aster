import type { Dispatch } from "react";
import { activeComposition } from "../core/project/project";
import type { Project } from "../core/types";
import type { EditorAction } from "./editor-store";

/** Loading a project no longer selects a layer; component tests opt into a selected layer. */
export function selectFirstLayer(dispatch: Dispatch<EditorAction>, project: Project): void {
  const layer = activeComposition(project).layers[0];
  if (layer) dispatch({ type: "select", ids: [layer.id] });
}
