# Path morph animation

Bezier shape settings optionally contain `morph: { target, progress }`. The target has the same ordered anchor count and open/closed topology as `shape.path`; incompatible topology and invalid/non-finite coordinates are rejected at the project boundary. Existing projects without a morph keep their static path behavior.

`progress` is the standard static/animated numeric property in percent. MCP can configure the target with `setShapeSettings` and address progress as `shape.morphProgress` in `setProperty`, `addKeyframe`, keyframe editing, and expressions. The Inspector reuses the numeric/keyframe control, and Timeline/Graph Editor expose the same curve. Changing a primitive clears its morph; changing open/closed state updates both paths together.

At an explicit composition time, the renderer interpolates anchor positions and both tangent vectors. It then uses the existing adaptive path tessellation, fill, stroke, and GPU compositing. No Canvas text rasterization or texture upload is introduced by the morph. Endpoint evaluations reuse the original immutable path resources. Seeking backwards, evaluating out of order, precomposition local time, and export use the same evaluator. Progress is clamped to 0–100 for rendering; vertex order is not automatically matched or resampled.

Validation covers actual MCP command normalization, serialization, topology rejection, timeline exposure, expression evaluation, changing GPU geometry, and repeatable random-time evaluation.

Analytic ellipse, rectangle, and line paints also keep fill alpha and stroke alpha independent. Transparent fills do not suppress visible outlines. Their existing material flag slot carries whole-layer opacity in the unlit analytic shader branch, so stroke-over-fill composition applies layer opacity once without additional vertex attributes, textures, or draw passes. Bezier paths retain their separate tessellated fill/stroke geometry.
