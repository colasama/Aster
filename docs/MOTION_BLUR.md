# Motion blur

Aster follows After Effects' two-switch model: the composition Motion Blur switch and the layer's
Motion Blur switch must both be enabled. Shutter Angle sets exposure duration in frame units, and
Shutter Phase offsets the opening relative to the current frame. The default 180-degree angle and
-90-degree phase produce an exposure centered on the frame time.

Motion is always time-addressed. Shape, text, solid, footage, precomposition, and mesh layer geometry
is evaluated at the exact shutter open and close times and feeds those endpoint displacements to the
GPU motion-vector pass. Time-varying text animator geometry also evaluates the canonical midpoint
samples across that same interval. Position, anchor, scale, XYZ rotation, skew, tracking, line anchor
and spacing, character replacement, and animated glyph blur therefore contribute even when the text
layer's world transform is static. Results do not depend on the previously rendered frame, playback
direction, seeking, dropped frames, preview resolution, or whether a frame is produced by the
interactive or background renderer. Audio, null, camera, light, adjustment, and generators do not
expose a layer switch because they have no stable drawable endpoint topology in this renderer.

The beauty path performs a 16×16 tile maximum, a neighboring-tile maximum, and bounded adaptive
reconstruction in premultiplied linear HDR. Object IDs reject unrelated surfaces while allowing a
visible moving foreground to cover static background pixels, preserving silhouettes and transparent
edges. Screen-space travel raises reconstruction samples from Samples Per Frame to Adaptive Sample
Limit and the blur radius is capped at 256 preview-scaled pixels. Tone mapping happens once after
motion blur; camera depth of field then consumes the blurred linear scene before the same canonical
display transform. Preview, interactive frame capture, MP4, and background renders all call this one
renderer path.

Glyph samples are rasterized at exact layer-source times rather than the ordinary frame-rate text
cache buckets. Canvas visual blur is applied inside each sample first. WebGPU then samples the sRGB
rasters as linear color, accumulates premultiplied RGBA in an `rgba16float` target, and performs one
straight-alpha sRGB resolve for the existing media shader. The resolved texture supplies
texture-local character motion while the regular quad vectors independently supply layer/world
motion and occlusion. This avoids black fringes, double premultiplication, and double-counting the
layer transform.

The temporal text path is lazy: both motion-blur switches and a genuinely time-varying text stack are
required. A single unique shutter state uses the ordinary one-raster path. Exact sample generations
use microsecond cache identities; duplicate clamped times share exposure weight. Sample and linear
accumulation textures are released immediately after command submission, while at most 64 resolved
generations remain active. Resident and transient generations each have a 384 MiB ceiling; memory
pressure deterministically coalesces canonical samples instead of retaining an unbounded per-time
cache. If a requested supersampling scale cannot retain at least two samples, the temporal path
chooses the largest lower 1.25× raster bucket that can; the frame metric reports that reduction. A
1× generation that cannot fit fails with its dimensions and required/budgeted bytes instead of
silently producing a one-sample non-blur.

The timeline toolbar owns the composition switch, each supported layer row owns its layer switch,
and the Inspector exposes Shutter Angle, Shutter Phase, Samples Per Frame, and Adaptive Sample Limit.
At expanded timeline zoom, the ruler shows the exact shutter-open to shutter-close interval.

Adobe behavior reference:

- [Adobe After Effects: Apply motion blur to a layer](https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/assorted-animation-tools/assorted-animation-tools.html)
