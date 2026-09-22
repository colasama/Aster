# Advanced rendering roadmap

This document records decisions for planned features. It does not claim that vertical shaping,
variable fonts, cascaded shadows, OCIO, or HDR presentation are active.

## Vertical and variable text

Vertical text is a shaping mode, not a rotated horizontal texture. A future `aster-text` shaper uses
Unicode vertical orientation plus OpenType `vert`/`vrt2`, `vhea`, and `vmtx`; HarfBuzz-style
top-to-bottom shaping supplies vertical advances and glyph substitutions. CJK punctuation uses the
font's vertical forms, Latin runs follow explicit upright/sideways policy, and fallback is resolved per
grapheme before shaping. Line progression, ruby, selection geometry, caret hit testing, and animation
indices remain logical-text based. Raster cache keys include direction, script, language, features,
font identity, size, variation coordinates, and quantized subpixel position. Fixtures must cover mixed
CJK/Latin/emoji, combining marks, fallback fonts, punctuation, and right-to-left text embedded in a
vertical run.

Variable-font axes are persisted as sorted `{tag, value}` pairs, bounded by `fvar` ranges and stripped
when unsupported by the selected face. Named instances are UI presets over the same axis values.
Shaping and glyph-cache identities include normalized axis coordinates and the font content hash;
changing an axis cannot reuse outlines or advances from another instance. `avar`, `STAT`, HVAR/VVAR,
MVAR, and optical-size behavior are applied by the shaping/raster backend, never approximated in the
canvas fallback. Unknown axes fail closed on import but missing fonts retain the requested values for
relinking. Atlas pressure diagnostics group variation instances by font and axis tuple.

## Cascaded directional shadows

The first cascaded-shadow implementation uses one to four cascades in a depth atlas, with three as the
quality default. Split distances use a practical logarithmic/uniform blend, are computed from the
active camera's positive near/far interval, and overlap for a bounded cross-fade. Each light-space
orthographic projection is snapped to shadow texels to prevent shimmer. Culling, indirect draw data,
depth bias, normal bias, filter radius, and atlas allocation are per cascade but share scene geometry
buffers. The memory-pressure manager reduces resolution then cascade count before disabling shadows.

Only the camera-visible receiver range participates; off-screen casters expand each cascade by a
bounded margin. Point and spot lights keep their existing single-map path. Debug views expose cascade
index, split planes, atlas occupancy, and bias. Release gates include stable-camera shimmer, moving
camera/mesh, large world coordinates, alpha-tested casters, cascade seams, device-limit fallback, and
GPU time/VRAM diagnostics across 1K/2K/4K atlas budgets.

## ICC, OCIO, and HDR

Aster keeps one scene-referred linear working space. Embedded image/video ICC data is decoded at the
asset boundary; display ICC is applied only for preview, and output transforms occur once at export.
The MVP color pipeline uses linear-sRGB compositing and an sRGB SDR output transfer, with filmic
tone mapping available as an explicit effect. OCIO is a later optional,
versioned configuration provider: projects store a configuration content hash, color-space names,
looks, and display/view names rather than machine paths. Missing configurations open safely with the
transform disabled and a diagnostic. GPU OCIO shaders are compiled through the normal validated
pipeline cache; a CPU reference supplies golden values and unsupported operations fail before export.

HDR presentation is capability-gated per monitor and swapchain. The sequence is: linear scene values,
working-space conversion, exposure/look, chosen tone/gamut mapping, then PQ/HLG or platform scRGB
encoding with mastering metadata. SDR UI chrome is composited in a separately calibrated reference
white range. Moving the window between monitors rebuilds only presentation resources and never
changes project pixels. SDR fallback is always available and must match HDR tone-map reference output.

HDR export requires explicit primaries, transfer, matrix/range, mastering luminance, content light
levels, 10-bit pixel format, and container metadata round-trip. Gates cover negative/over-range scene
values, BT.709/P3/BT.2020 gamut boundaries, 1,000/4,000/10,000-nit ramps, SDR-white policy, mixed-monitor
movement, screenshots, GPU/CPU transform agreement, and device loss. No HDR label is shown until the
OS reports an HDR presentation surface and a rendered probe confirms the expected encoding.
