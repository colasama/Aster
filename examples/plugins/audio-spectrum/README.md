# Audio Spectrum Scene Generator

An audio-reactive Scene Generator built on the `audio_analysis` capability. It draws the spectrum
or waveform of whatever the composition plays: no baking, no keyframes, and identical results
when scrubbing, seeking, or exporting.

| Style | Look |
| --- | --- |
| `bars` | Classic rising bars with falling peak caps |
| `mirror` | Bars growing up and down, low frequencies in the center |
| `ring` | Radial bars around a circle, mirrored left and right, with bass pulse and spin |
| `line` | Smooth glowing spectrum curve |
| `scope` | Oscilloscope trace of the waveform |
| `dots` | LED matrix columns with a lit peak cell |

The layer position is the center of the baseline (or of the ring). Layer scale, rotation, opacity,
blend mode, 3D, and camera all apply. `Floor`/`Ceiling` choose the dB window that maps to an empty
and a full bar, `Tilt` lifts high frequencies (music falls off a few dB per octave), `Curve`
shapes the response, and `Release` sets how slowly bars fall. Every value is derived from the
host's 16-frame band history, so nothing depends on previously rendered frames.

Validate it from the repository root:

```sh
cargo run -p aster-plugin --example validate -- examples/plugins/audio-spectrum
```

Install it from **Window → Plugins → Install folder**, then add **Audio Spectrum** from the Project
panel's add menu into a composition that contains audio.
