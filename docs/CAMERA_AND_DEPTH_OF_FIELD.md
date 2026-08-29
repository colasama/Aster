# Camera and depth of field

Aster models an After Effects camera as a horizontal film-back projection. Film size and Zoom are
authoritative time-addressable tracks; focal length and angle of view are derived at evaluation time.
Editing focal length performs the exact inverse conversion into Zoom. The 50 mm
default on a 36 mm film back has a 39.598-degree horizontal view and a 2666.667-pixel Zoom in a
1920-pixel-wide composition. A layer at the Zoom distance therefore appears at full scale.

Depth of field is a production render option on perspective cameras. Focus Distance defines the
perfectly sharp plane, Lock to Zoom follows evaluated lens changes, and AE Aperture is an
authoritative 72-dpi pixel track. F-Stop is the reciprocal settings view
`FocalLengthMm / (AperturePx × 25.4 / 72)` and edits that view back-propagate to the current Aperture
value. The 50 mm default at f/5.6 therefore evaluates to 25.31 px. Focus Area Width creates a fully sharp
interval around the focus plane. Near and Far Blur
Level scale the two sides independently, while Blur Level scales the physically derived result as a
whole. Aperture does not change exposure, matching After Effects rather than a photographic exposure
simulation.

The signed circle of confusion is evaluated entirely in AE virtual-camera pixel units: Aperture,
Zoom, Focus Distance, and surface distance never mix with millimetre focal length. Its magnitude
scales only with output resolution: a half-resolution production preview
uses exactly half the radius in pixels and therefore retains the same composition-space appearance.
Orthographic cameras do not apply lens depth of field. Render Quality maps to a bounded 8–64 sample
budget and never changes lens geometry. Iris shape, rotation, roundness, aspect ratio, diffraction
fringe, and highlight gain/threshold/saturation are bounded camera tracks consumed directly by the
GPU bokeh sampler.
The AE-compatible default bokeh preset is Fast Rectangle, 0° rotation, 0% roundness, 1.0 aspect
ratio, and zero diffraction or highlight gain.
Highlight Threshold is normalized to the 32-bpc `0..1` range because Aster's canonical render path
is floating-point HDR and does not expose an 8/16-bpc project mode.

Advanced 3D transparency uses a bounded GPU-resident depth peel. K2 keeps independent premultiplied
color, coverage, and view depth for the front and second surfaces; deeper surfaces use a separately
diagnosed aggregate-depth residual instead of assigning one CoC to the already-composited beauty.
Opaque surfaces always sample the canonical lit/effected HDR beauty, while transparent colors are
separated before their own CoC. The allocator selects K2, K1, or K0 before creating textures. K1
keeps an exact front surface plus aggregate deeper depth, and K0 keeps canonical beauty plus primary
depth. Both reduced tiers are exposed through GPU diagnostics. Non-DOF MRT visualization allocates
none of these layered targets. Production readback requires K2 and reports an actionable allocation
failure rather than exporting reduced-tier transparency. Diffraction Fringe conserves sampled energy and moves it radially
toward the iris boundary; it is not chromatic aberration.

The camera rig uses AE composition coordinates (right, down, forward). Its default two-node camera is
centered at `[width / 2, height / 2, -Zoom]` and points at the composition center, so the `z = 0`
plane maps one-to-one to composition pixels. One-node cameras use Orientation plus XYZ Rotation;
two-node cameras first construct a stable Point of Interest frame and then apply those rotations.
World/project conversion, orthographic projection, screen rays, orbit, pan, and dolly share the same
orthonormal basis. Degenerate coincident or vertical camera poses use deterministic fallback axes.
Changing Zoom or Focus Distance through the inspector or a timeline property operation releases Lock
to Zoom. Camera precedence requires an enabled Video switch, the half-open timeline span
`inPoint <= time < outPoint`, and topmost timeline order; Solo does not independently select a camera.
A disabled camera does not participate in selection. An enabled camera participates in selection but
does not draw a visible surface of its own.

Adobe behavior references:

- <https://helpx.adobe.com/after-effects/using/cameras-lights-points-interest.html>
- <https://helpx.adobe.com/after-effects/desktop/work-with-3d-composition/work-with-3d-scene-depth-data/enable-in_engine-depth-of-field-in-advanced-3d.html>
