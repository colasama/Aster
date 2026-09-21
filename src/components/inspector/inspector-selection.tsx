import { createContext, type ReactNode, useContext } from "react";
import type { Layer } from "../../core/types";

const InspectorLayers = createContext<readonly Layer[] | undefined>(undefined);

export function InspectorSelection({
  layers,
  children,
}: {
  layers: readonly Layer[];
  children: ReactNode;
}) {
  return <InspectorLayers.Provider value={layers}>{children}</InspectorLayers.Provider>;
}

export function useInspectorLayers(layer: Layer): readonly Layer[] {
  return useContext(InspectorLayers) ?? [layer];
}

export function valuesDiffer<T>(values: readonly T[]): boolean {
  return values.some((value) => !Object.is(value, values[0]));
}
