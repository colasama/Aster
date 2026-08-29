# Camera and depth of field

Aster models an After Effects camera as a horizontal film-back projection. Focal length and film
size determine Zoom and angle of view; editing Zoom performs the exact inverse conversion. The 50 mm
default on a 36 mm film back has a 39.598-degree horizontal view and a 2666.667-pixel Zoom in a
1920-pixel-wide composition. A layer at the Zoom distance therefore appears at full scale.

Depth of field is a production render option on perspective cameras. Focus Distance defines the
perfectly sharp plane, Lock to Zoom follows changes to the lens, and Aperture and F-Stop remain
reciprocal. Focus Area Width creates a fully sharp interval around the focus plane. Near and Far Blur
Level scale the two sides independently, while Blur Level scales the physically derived result as a
whole. Aperture does not change exposure, matching After Effects rather than a photographic exposure
simulation.

The signed circle of confusion is evaluated in camera space and converted through the film back into
render pixels. Its magnitude scales only with output resolution: a half-resolution production preview
uses exactly half the radius in pixels and therefore retains the same composition-space appearance.
Orthographic cameras do not apply lens depth of field. Render Quality maps to a bounded 8–64 sample
budget and never changes lens geometry.

Adobe behavior references:

- <https://helpx.adobe.com/ca/after-effects/desktop/work-with-layers/camera-layer/cameras-lights-points-interest.html>
- <https://helpx.adobe.com/ca/after-effects/desktop/work-with-3d-composition/work-with-3d-scene-depth-data/enable-in_engine-depth-of-field-in-advanced-3d.html>
