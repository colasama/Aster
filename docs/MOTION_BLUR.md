# Motion blur

Aster follows After Effects' two-switch model: the composition Motion Blur switch and the layer's
Motion Blur switch must both be enabled. Shutter Angle sets exposure duration in frame units, and
Shutter Phase offsets the opening relative to the current frame. The default 180-degree angle and
-90-degree phase produce an exposure centered on the frame time.

Motion is always time-addressed. Shape, text, solid, footage, precomposition, and mesh geometry are
evaluated at the exact shutter open and close times and feed those endpoint displacements to the GPU
motion-vector pass. Results do not depend on the previously rendered frame, playback direction,
seeking, dropped frames, preview resolution, or whether a frame is produced by the interactive or
background renderer. Audio, null, camera, light, adjustment, and generators do not expose a layer
switch because they have no stable drawable endpoint topology in this renderer.

The beauty path performs a 16×16 tile maximum, a neighboring-tile maximum, and bounded adaptive
reconstruction in premultiplied linear HDR. Object IDs reject unrelated surfaces while allowing a
visible moving foreground to cover static background pixels, preserving silhouettes and transparent
edges. Screen-space travel raises reconstruction samples from Samples Per Frame to Adaptive Sample
Limit and the blur radius is capped at 256 preview-scaled pixels. Tone mapping happens once after
motion blur; camera depth of field then consumes the blurred linear scene before the same canonical
display transform. Preview, interactive frame capture, MP4, and background renders all call this one
renderer path.

The timeline toolbar owns the composition switch, each supported layer row owns its layer switch,
and the Inspector exposes Shutter Angle, Shutter Phase, Samples Per Frame, and Adaptive Sample Limit.
At expanded timeline zoom, the ruler shows the exact shutter-open to shutter-close interval.

Adobe behavior reference:

- [Adobe After Effects: Apply motion blur to a layer](https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/assorted-animation-tools/assorted-animation-tools.html)
