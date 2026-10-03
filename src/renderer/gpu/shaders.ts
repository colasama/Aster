import { sharedShaders } from "./shared-shader-catalog";

export {
  imageShader,
  materialShapeShader,
  shadowShader,
  shapeShader,
  textureCompositeShader,
} from "./base-shaders";

export const postProcessShader = sharedShaders.source("post-process");
