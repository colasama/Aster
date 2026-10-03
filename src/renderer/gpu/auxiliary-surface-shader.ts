import { sharedShaders } from "./shared-shader-catalog";

/** Surface-data, two-layer depth-peel, and aggregate transparency shader. */
export const auxiliarySurfaceShader = sharedShaders.source("auxiliary-surface");
