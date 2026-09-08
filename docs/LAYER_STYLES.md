# Layer effects and blending options

Right-click a visual layer in the timeline and choose **Layer Effects** to add
Outer Glow, Shadow or Color Fill. Multi-selection adds independent effect instances
in one undo step. Locked layers and nonvisual/control layers disable this submenu.
The Inspector edits the resulting effect stack; it contains no style-add buttons.
Existing enable, remove, reorder, color, numeric scrub, mask and keyframe controls
remain available. Numeric previews coalesce to animation frames and Escape cancels
an in-progress numeric edit.

**Blending Options** exposes layer opacity and thirteen blend modes: normal, add,
multiply, screen, overlay, darken, lighten, color burn, color dodge, soft light,
hard light, difference and exclusion. Opacity uses the existing animatable transform.
Effects execute before the layer blends with its accumulated backdrop. Reordering
Color Fill after an alpha-expanding effect also colors that expanded result; place
Color Fill before glow/shadow to retain their independently selected colors.

## Rendering

Outer glow and shadow sample source alpha through a bounded 9-by-9 Gaussian kernel.
Spread interpolates between the softened field and its neighborhood maximum, so
fully transparent areas remain transparent. Samples outside the composition are
zero. Shadow direction, offset, softness, spread, color and opacity are adjustable;
glow adds a falloff range. Style RGB is composited behind the current source using
source-over alpha, then converted back to straight color for the fused effect stack.
Black halos therefore preserve glyph color and antialiased edge coverage.

The fixed 81-sample kernel bounds work independently of radius. Very wide glows on
thin geometry can reveal sparse sampling; this is an approximation, not an exact
large-radius Gaussian convolution. No CPU pixel processing or readback is used.

Normal, additive and screen layers retain hardware blending. Other modes isolate
the source, apply its effects, then copy the accumulated backdrop into the now-unused
effect input texture. The blend pass reads separate source/backdrop textures and
replaces the target. It needs no additional full-frame texture beyond the existing
two color surfaces and depth allocation. This path also runs in isolated precomps;
the source raster always uses normal blending there. Pipeline variants are cached.

Blend equations follow the separable formulas and source-over alpha in the
[W3C compositing specification](https://www.w3.org/TR/compositing-1/#blending),
evaluated in Aster's existing linear HDR working space. This is not a claim of
pixel identity with display-space blending in another editor.

## Persistence and automation

Project schema version is unchanged: `layer.blendMode` accepts the thirteen names
listed in `BLEND_MODES`; `effects` retains the existing parameter/keyframe structure.
Drop Shadow adds optional `spread` (0–100, default 0). Existing projects load with
their previous parameters, with corrected alpha semantics. Earlier app versions
do not implement the eight additional blend modes. Plugin ABI declarations remain
unchanged; advanced layer blending happens outside generator source pipelines.

MCP uses `setBlendMode`, `addEffect`, `setEffectParameter` and existing effect
keyframe commands. Existing opcodes are retained; Drop Shadow's previously unused
eighth parameter carries spread. No plugin parameter ABI changes are required.

## Validation

Run `pnpm exec lefthook run pre-push` and `pnpm build` for project checks. The
additional hardware check is `scripts/gpu-layer-styles-check.mjs`: start Vite with
`ASTER_BUNDLED_DEV=0`, open its page in a WebGPU-enabled browser and run:

```js
await (await import('/scripts/gpu-layer-styles-check.mjs')).run();
```

It compares fifty GPU output cases with blend equations across partial alpha,
transparent source/backdrop and black/white boundary values. A real render through
`LayerEffectRenderer` also checks isolated black glow, preserved glyph alpha and
color fill and directional shadow placement. Readback is restricted to this diagnostic,
never interactive rendering.
