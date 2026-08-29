# Motion blur

Aster follows After Effects' two-switch model: the composition Motion Blur switch and the layer's
Motion Blur switch must both be enabled. Shutter Angle sets exposure duration in frame units, and
Shutter Phase offsets the opening relative to the current frame. The default 180-degree angle and
-90-degree phase produce an exposure centered on the frame time.

Motion is always time-addressed. Vector-capable affine layers evaluate transforms at the exact shutter
open and close times and feed those endpoints to the GPU motion-vector pass. Results do not depend on
the previously rendered frame, playback direction, seeking, dropped frames, preview resolution, or
whether a frame is produced by the interactive or background renderer.

Video, nonlinear deformation, temporal effects, and renderers without reliable motion vectors use
linear-HDR accumulation at stratified shutter samples. The base sample count and adaptive limit are
bounded; estimated screen-space travel increases samples up to that limit. Tone mapping happens once
after accumulation. This avoids both incorrect nonlinear vectors and repeated display transforms.

Adobe behavior reference:

- <https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/assorted-animation-tools/assorted-animation-tools.html>
