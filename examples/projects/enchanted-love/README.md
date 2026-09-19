# Enchanted Love — native composition study

A full-length reconstruction of the user-supplied `255803230-1-208.mp4`, built with editable Aster
primitives, short Bezier paths, reusable props, articulated character rigs, and sparse motion curves.
The reference is 1280 × 848, 30 fps, 3,903 video frames, and 130.1 seconds long. Its audio stream is
stereo AAC at 48 kHz. The source video and soundtrack are not distributed in this repository.

## Build and open

From the repository root, run:

```powershell
node examples/projects/enchanted-love/build.mjs artifacts/enchanted-love
```

To include a locally supplied M4A soundtrack, add its path as the third argument:

```powershell
node examples/projects/enchanted-love/build.mjs artifacts/enchanted-love path/to/soundtrack.m4a
```

Open the generated bundle directory in Aster. `project.json` is the native project; `shots.json`
lists the 47 scene boundaries. The master composition includes the complete 130.1-second edit and
uses the original frame rate and dimensions. Aster's Save Project operation can collect the embedded
audio into the bundle's media directory.

## Editing model

| Source | Responsibility |
| --- | --- |
| `authoring.mjs` | Native layer, keyframe, transform, paint, and effect helpers |
| `props.mjs` | Crown, heart, stairs, window, swim ring, ball, pitched umbrellas, fish, snail, turtle, crab, lily pad |
| `character-artwork.mjs` | Shared heads, expressions, hair, and tunic |
| `characters.mjs` | Shared heads and tunic; torso, head, arm and leg pivots; semantic poses and walk cycle |
| `character-poses.mjs` | Joint angles and proportions for standing, sitting, carrying, sliding, and other poses |
| `scenes.mjs` | Repeated patterns, spotlights, shadows, reusable group and scene helpers |
| `doorway.mjs` | Continuous frog exit, beam mask, and camera shared across two shots |
| `striped-passage.mjs` | Coarse/fine cloner patterns, curved reveal boundaries, reversing pan, and pool lead-in |
| `umbrella-accents.mjs` | Delayed crown outlines, constrained umbrella grip, curling frog card, and folding hearts |
| `parade.mjs` | Shared parade camera, retimed canopy pitch, striped paper, and horizon transition |
| `playground.mjs` | Seesaw fulcrum, camera turn, foreground bank, rolling props, and recovery pose |
| `dive.mjs` | Recovery, running gait, retracting ledge, dive trajectory, waterline, and depth transition |
| `crown-staircase.mjs` | Modular treads, rolling crown, and one accelerating window camera |
| `shaft-reunion.mjs` | Widening spotlight, shared crossing camera, near-plane lighting, and crown travel |
| `reunion.mjs` | Rising turtle riders and floor columns, crown light, and concentric iris |
| `circular-passage.mjs` | Receding irises, a reused six-colour cycle, radial clock, zoom, and spiral crown |
| `act-one.mjs` | Opening through the first title card |
| `act-two.mjs` | Music, pool, umbrella, balance, and dive sequences |
| `act-three.mjs` | Light shafts, reunion, return walk, kiss, and credits |
| `build.mjs` | Native project assembly, asset folders, audio embedding, and shot list |

The generated project has 139 compositions and 1,402 authored layers. The 47 scene compositions
instantiate the shared props and character poses. Thirteen native grid cloners replace hundreds of
repeated stripe and chevron layers. The longest authored path has 10 anchors; the crown has seven,
and each ring sector has four. There are no frame contour tracks, image sequences, or embedded
reference-video layers. The only external media dependency is the optional soundtrack.

Motion is evaluated at arbitrary time. Crown travel uses sparse position and rotation landmarks
with Bezier timing; orbit, breathing, and walk cycles use periodic expressions. Scene wrappers map
master time into local time. Window lighting uses two reusable group passes and a moving crop;
circular lighting uses a group alpha mask. Native GPU effects and shared source surfaces keep the
compositing path on the GPU. Foreground limbs remain separately editable above the tunic.

The same rig supplies closed-eye cuddling, seated reunion, overhead diving, and standing with the
frog. Pose data stores joint angles and limb lengths. The stair walk alternates a planted leg with
a bent swing leg over a 1.067-second cycle; ankle rotation keeps the feet aligned. Three paired
windows follow sparse rightward/downward camera paths, with the light crop following each window.

The doorway uses seated and falling frog poses inside one lit tableau, followed by a camera pan;
the next shot continues sampling that same source. The pool shot nests the frog below the girl's
forearm and places the complete rig in a ring. One decelerating drift moves and turns this group
and its cast shadow. The late iris uses two expanding circles with fitted center/edge/radius curves.
The staircase enters from above after that transition. These are object and camera parameters,
not per-frame contour data.

The seesaw places the plank and all riders under one fulcrum; a separate triangular support stays
fixed. Its seated pose has dangling legs and palms on the plank. The snail uses a short body path,
simple eyes, and a five-anchor spiral. The slope sequence has one rotating ground frame; the same
foreground plane hides the lower limbs and constrains the ring, frog, ball, and crown. Ring rotation
follows travel divided by radius. The girl reaches out, protects her head, and unfolds her legs
through a few joint poses. The camera angle follows a fitted rational curve rather than frame keys.

The parade reuses a six-anchor canopy whose pitch passes through top, side, and underside views.
Time remapping offsets each instance along that pose strip, while its handle foreshortens with pitch.
A front-facing held-umbrella pose, native cloners, and a shared pan keep the
scene editable without duplicating hundreds of stripes or separately keying every prop's camera move.

The crown staircase repeats a three-anchor tread/riser module. Its windows share an accelerating
camera translation with regular world spacing. The swim-ring pose settles its head and free arm
while the raft drifts and turns; the held frog remains attached to the torso beneath the forearm.
The reunion seats both riders on a reusable turtle assembled from a six-anchor shell, oval flippers,
and simple head and eye shapes. Staggered cloner columns form the pool floor. Separate radius curves
expand the surrounding iris and preserve its central crown medallion.

The ledge sequence shares a settling camera between the recovering character, foreground bank,
and rolling props. A two-step running cycle combines opposed hip swing with delayed knee flex;
the feet counter-rotate and the hip height follows leg reach. A foot-height anchor separates the
runner's perspective scale from the ground path. The destination circle, four-anchor retracting
ledge, crown, and dive share one world camera. Two accelerating descent curves meet at water entry.
The same diver rig supplies the submerged blue silhouette; a crop follows the projected waterline.
Two broad water surfaces, a six-anchor splash, and a rounded column form the depth transition.
These are procedural poses and sparse camera landmarks, with no sampled frame geometry.


The circular passage repeats one six-circle composition with source-time offsets. One remapped
radial clock advances all cycles, while one scale track controls their spacing. Radius evaluation
uses a common power curve, and a fitted spiral moves the crown. Tucked floating and seated riding
poses reuse the same skeleton. No individual ring carries a frame-by-frame radius track.

The late spotlight is a four-anchor frustum with two width controls and a perspective border.
Crossing riders share one camera and one source surface between their blue and lit passes. Two
angled half-plane wipes intersect the near light field. A damped rise brings the frontal tableau
and pool floor into view before the crown medallion expands. The outer cream disc stays fixed
while the green iris accelerates over it; this avoids an unintended expanding cream flash.

The reference palette is measured from decoded frames. Shape paints invert Aster's ACES display
mapping to reproduce those display colors. Text also accounts for its sRGB texture encoding.

## Fidelity and validation

This is a full-length semantic reconstruction with remaining fidelity gaps. An every-frame audit
exposed short passages that sparse still comparisons missed. The striped reversal and umbrella-girl
interlude now have continuous semantic assemblies, but their detailed curves and poses remain
approximate. The shaft crossing and frontal reunion now share continuous camera and lighting assemblies.
The circular passage uses shrinking discs followed by a repeated six-colour depth cycle; the
fastest final rings still have phase differences. Several water and palette transitions need
reconstruction or retiming. Hand-drawn
anatomy, gestures, lettering, spherical ball rotation, and particles remain approximate. The editable
rigs and scene-level paths are the intended places to refine those differences.

Native GPU captures are compared against decoded reference frames at matching 30 fps addresses.
Preview measurements count both playback-frame addresses and GPU submissions at full 1280 × 848
resolution with FXAA. A high refresh callback count alone is not considered proof of 30 fps.
The generated project, native MP4 export, comparison sheets and machine-readable performance data
are local artifacts, not committed binaries.

Temporal screening pairs all 3,903 exported frames with the reference at matching 30 fps addresses.
Metadata-aware FFmpeg RGB decoding followed by area downsampling to 320 × 212 exposes broad layout,
palette, and cut-timing errors between the full-resolution review samples. Per-frame measurements,
per-scene summaries, and representative transition pairs are retained with each audited delivery.
These diagnostics do not provide a perceptual similarity score or source frame assets for authoring.

The engine changes needed by this study are documented in
[Semantic vector compositing](../../../docs/SEMANTIC_VECTOR_COMPOSITING.md). They cover bounded 2D
group surfaces, mapped effect time, reflected joints and strokes, metric rounded corners, curved
wipe boundaries, precise nested cut visibility, and lower-allocation vertex packing.
