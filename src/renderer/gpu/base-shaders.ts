import { sharedShaders } from "./shared-shader-catalog";

export const shapeShader = sharedShaders.source("scene-shape");
export const materialShapeShader = sharedShaders.source("scene-material-shape");
export const shadowShader = sharedShaders.source("scene-shadow");
export const imageShader = sharedShaders.source("scene-image");
export const textureCompositeShader = sharedShaders.source("texture-composite");
