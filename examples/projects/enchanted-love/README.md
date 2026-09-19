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
lists the 48 scene boundaries. The master composition includes the complete 130.1-second edit and
uses the original frame rate and dimensions. Aster's Save Project operation can collect the embedded
audio into the bundle's media directory.

## Editing model

| Source | Responsibility |
| --- | --- |
| `authoring.mjs` | Native layer, keyframe, transform, paint, and effect helpers |
| `props.mjs` | Crown, heart, stairs, window, swim ring, ball, umbrella, fish, crab, lily pad |
| `characters.mjs` | Shared heads and tunic; torso, head, arm and leg pivots; semantic poses and walk cycle |
| `scenes.mjs` | Repeated patterns, spotlights, shadows, reusable group and scene helpers |
| `act-one.mjs` | Opening through the first title card |
| `act-two.mjs` | Music, pool, umbrella, balance, and dive sequences |
| `act-three.mjs` | Light shafts, reunion, return walk, kiss, and credits |
| `build.mjs` | Native project assembly, asset folders, audio embedding, and shot list |

The generated project has 96 compositions and 944 authored layers. The 48 scene compositions
instantiate the shared props and character poses. Five native grid cloners replace hundreds of
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

The reference palette is measured from decoded frames. Shape paints invert Aster's ACES display
mapping to reproduce those display colors. Text also accounts for its sRGB texture encoding.

## Fidelity and validation

This is a semantic reconstruction, not a pixel-identical restoration. The full scene sequence and
main visual motifs are present. Hand-drawn anatomy, some gestures and transition timing, the exact
lettering, the spherical ball rotation, and individual particles still differ from the reference.
The editable rigs and scene-level paths are the intended places to refine those differences.

Native GPU captures are compared against decoded reference frames at matching 30 fps addresses.
Preview measurements count both playback-frame addresses and GPU submissions at full 1280 × 848
resolution with FXAA. A high refresh callback count alone is not considered proof of 30 fps.
The generated project, native MP4 export, comparison sheets and machine-readable performance data
are local artifacts, not committed binaries.

The engine changes needed by this study are documented in
[Semantic vector compositing](../../../docs/SEMANTIC_VECTOR_COMPOSITING.md). They cover bounded 2D
group surfaces, mapped effect time, reflected joints and strokes, and metric rounded corners.
