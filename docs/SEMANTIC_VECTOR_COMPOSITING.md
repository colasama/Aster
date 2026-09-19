# Semantic vector compositing

The Enchanted Love reconstruction in `examples/projects/enchanted-love` uses small native paths,
primitive shapes, articulated null hierarchies, reusable compositions, and time-addressable curves.
It does not render traced frame contours or embed the reference video as its visual output.

## GPU group effects

`needsPrecompositionSurface` is shared by scene evaluation and project render-boundary validation.
A 2D wrapper with enabled effects takes the existing precomposition surface path; its source is
evaluated at mapped local time and composited before its effect chain runs. Masks, crop, and colour
overlay therefore operate on the combined group alpha. Switching the effect off returns the group
to ordinary flattening. Wrapper size and anchor remain editable without changing source dimensions.
Flattening applies the wrapper's evaluated anchor offset before the source-to-wrapper size ratio,
including rotation and reflection. Animated off-center pivots therefore keep the same GPU corners
when an effect is enabled or disabled; ordinary groups still allocate no intermediate surface.
Flattened geometry and generators retain their evaluated local time in the render stack. Effect
parameters use that time in both the main renderer and isolated surface renderer, so a moved or
retimed shot does not sample its masks at the master timeline's time.

Source surfaces are shared by composition, time, revision, and target size. Existing count, depth,
pixel, and VRAM budgets remain in force, including the diagnostic on downgrade or exhaustion. No CPU
image readback is introduced. The reconstruction groups whole spotlight actors or a complete shadow
pass instead of allocating one effect surface per limb.

## Shape and rig corrections

Rectangle distance evaluation uses width/height relative to the smaller dimension. Circular corners
therefore retain their radius on tall or wide rectangles instead of becoming elliptical. The two
otherwise unused rectangle dash slots carry the metric aspect in the existing vertex layout. Colour
and auxiliary surface passes use the same metric. Ellipse, line dash, and mesh attributes keep their
existing interpretation; there is no plugin or project ABI change.

Analytic shape antialiasing uses the screen-space derivative of its signed distance instead of a
fixed UV width. Ellipses and rounded rectangles keep a pixel-sized edge when enlarged for a camera
move or iris transition. Derivatives execute before divergent fragment branches; this requires no
extra texture, render pass, or CPU work. In the 104-second native iris capture, three off-axis edge
samples reduced their intermediate-color span from 19 pixels to 1–2 pixels at 1280 × 848 with FXAA.

Parent and nested 2D transformations reverse child Z rotation under an odd number of XY reflections.
This keeps a mirrored puppet's upper and lower limbs connected. General nonuniform affine shear and
arbitrary 3D parent matrices remain outside this change.
Bezier stroke tessellation also preserves the sign when converting back from scaled coordinates;
mirroring a path no longer reflects its fill and stroke in different directions.

Stroke joins fill the exterior of each turn. The segment quads already overlap on
the interior, so joining that side leaves radial cracks on wide curves. Miter,
bevel, and round joins share the corrected turn sign; tests cover both turn
directions and points along the outside of a broad cubic arc. Round and bevel
triangle counts are unchanged. A miter adds the missing inner triangle between
the segment corners; no extra render pass or intermediate surface is required.

## Reusable motion assemblies

The example keeps pose parameters separate from character construction. A seated seesaw pose,
front-facing umbrella grip, and a sliding/recovery sequence use the same torso, head, tunic, and
joint hierarchy. The seesaw's riders share a rotating fulcrum. The sliding sequence evaluates one
camera angle and a ground distance; its foreground plane provides occlusion, while ring rotation
comes from travel divided by radius. These ordinary 2D hierarchies need no intermediate surface.

An umbrella pose strip morphs six canopy anchors between top, profile, and underside views and
foreshortens the handle. Instance time remapping chooses and advances each pitch. A single camera
pan moves the parade and its cloner-generated striped paper. The construction is independent of
frame sampling and adds no project schema or plugin ABI fields.

The crown staircase repeats a three-anchor tread/riser module beneath a sparse rolling path. A
single accelerating camera moves regularly spaced windows. The pool pose animates the head and
free arm within the existing joint hierarchy. Reunion riders share a turtle composition made from
a short shell path and analytic ellipses; staggered cloner columns form the floor. Independent iris
radius curves separate the outer wipe from the central crown medallion. These additions use the
existing project format and renderer, with no bitmap frame sequences or new runtime allocation path.

The dive sequence uses a periodic running rig, a foot-height anchor, a four-anchor retracting ledge,
and a shared destination camera. Position curves separate the airborne descent from water entry;
one reused rig surface supplies the submerged colour pass. Crop coordinates are relative to the
destination composition after placement, so the waterline crop follows its projected screen height.
The authoring morph helper converts target tangents and positions to the base path's units before
assigning the target. This prevents large paths with different normalization scales from shrinking
unexpectedly during a morph; it does not change the runtime path format or renderer.

The radial passage instantiates a single six-colour cycle at shifted source times. A common
radial clock and camera scale replace independent per-frame ring animation. Its circle radii
share a power curve, and the crown follows a separate fitted spiral. The light-shaft sequence
combines a four-anchor widening frustum, reusable side/front riding poses, two near-plane wipe
boundaries, and a damped rise. All use existing native transforms, source-time mapping, and GPU
compositing. Their source-time offsets preserve the intended clock when instances begin later.

The water study uses a morphing three-anchor fan, one cloned flow line, persistent lily-pad
instances, analytic circular currents, and a four-anchor swimming tail. A separate boundary
curve reveals the second patch while the objects share its current. The pool flash reuses the
complete raft and its cast shadow; a bowed card gives way to a crown toss with fitted temporal
Bezier curves. Balance and swimming use a joint pose, a small folded profile, a rotating ground
plane, and a pair of cubic parentheses. These authoring modules contain no captured contours or
per-frame drawing layers. Short palette beats and scene cuts remain explicit timeline spans.

## Curved wipe boundaries

Linear Wipe optionally bends its alpha boundary with a sine curve. `bend` and `bendWidth` are
composition-pixel amplitude and wavelength; `bendPhase` is degrees and `bendSpeed` is degrees per
second. The phase uses the owning composition's evaluated time. The retained source is sampled at
its original UV, so stripe patterns and character rigs remain intact. Amplitude contracts near the
0% and 100% endpoints to keep the wipe complete there. A zero bend preserves the straight wipe.

The existing opcode carries the four optional values in unused uniform slots. The pixel pass adds
one sine only when the bend is enabled, with no extra texture, draw pass, readback, or plugin ABI
change. Preview downsampling scales both pixel parameters. The normal numeric inspector controls
provide scrubbing, exact entry, bounds, keyframes, and undo for these values.

Scene visibility uses the same one-nanosecond tolerance on both ends of a half-open layer span.
Subtracting an offset shot's start from a rational frame time can otherwise round just below the
next layer's in-point. Adjacent layers still choose exactly one side of the cut; arbitrary-time
samples farther from the cut are unchanged.

The striped passage instantiates two cloner patterns and reverses their curved reveals. It extends
the existing pool drift into the incoming wipe. The umbrella interlude pins the gripping hand to
its handle, changes elbow extension and torso compression, and reuses the crown path for delayed
outline echoes. A four-anchor curling card carries the seated frog before becoming a crown and
three folding hearts. None of these assemblies uses captured frames as project media.

## Verification

Regression tests cover switching group effects on/off, animated off-center pivots, mapped source time,
retained wrapper size, parent and nested reflections, and tall/wide/mirrored rectangle metrics.
Native GPU captures exercise
the same features together in the spotlight, pool shadows, staircase lighting, and mirrored profile
shots. Preview measurement uses visible Electron playback at 1280 × 848, full quality and FXAA; it
records distinct 30 fps source frames in addition to GPU submissions. Submission rate alone is not a
playback-frame-rate result. Per-run data and the exported project are written under `artifacts`.

Fidelity checks also pair every exported frame with the reference using metadata-aware RGB decoding.
A 320 × 212 area downsample is used for broad temporal screening, alongside full-resolution native
GPU review captures. Per-frame RGB differences and changes between adjacent frames locate missed
cuts, flashes, and short passages; scene averages set refinement priorities. These diagnostics are
not perceptual similarity percentages and do not become authored geometry or visual media layers.

Color Overlay exposes a keyframable scene-linear `intensity` multiplier (0–16, default 1). The
ordinary colour picker supplies chromaticity; intensity allows a bright silhouette to retain HDR
values until display tone mapping. Missing values preserve legacy projects. Compilation multiplies
the existing RGB uniforms, so the operation, GPU ABI, surface count, alpha, and effect mask remain
unchanged. The native parameter inspector supplies scrubbing, bounds, animation, and undo. This
supports reusable bright character passes without copying or flattening their geometry.

The curved-wipe GPU regression can be run from a WebGPU browser served by an unbundled Vite server:
set `ASTER_BUNDLED_DEV=0`, start Vite, then run
`await (await import("/scripts/gpu-wipe-check.mjs")).run()` in that page. It checks retained gradient
pixels, complementary curved regions, nonsequential time evaluation, and full/half preview sizes
through the production beauty-frame pipeline. The fractional-frame cut regression exercises a
53-second wrapper at frame 1,591, including samples immediately before and after the cut.

CPU profiling of the water-line passage identified the geometry writer's repeated array spreading
and allocation as a hot path. Vertex packing now writes the existing 40 fields explicitly. Buffer
layout, shader ABI, and vertex values are unchanged; a 12-frame buffer hash comparison verifies
byte identity. A local 60-sample warmed geometry benchmark reduced median construction time from
10.42 to 6.67 ms and P95 from 22.00 to 8.87 ms. These CPU measurements are separate from visible
playback measurements. The water pattern also uses one 23-instance cloner instead of 23 layers;
that reduces authoring duplication, but the cloner alone did not fix the measured CPU stall.

An earlier 1280 × 848, FXAA, full-quality visible preview submitted all 3,903 source frames. CPU P95
was 2.10 ms, GPU P95 0.459 ms, the maximum submission interval 26.8 ms, and peak estimated VRAM
123.66 MiB. All 10-second bins contained 300 distinct frames. The cloner-only attempt is retained:
it missed frame 1,537 and had a 40.3 ms gap. This distinction prevents the authoring simplification
from being misreported as the runtime fix. Submission coverage does not measure physical scanout.
