# Audio layers

Aster models audio as time-addressable project data rather than as a side effect of visual playback.
An audio-only source creates a first-class `audio` layer with no visual surface. Video sources can
expose an embedded audio stream through the same controls. Both store stereo level in decibels, pan,
mute, reverse, the layer audio switch, solo, in/out points, source offset, and time stretch.

This follows the relevant After Effects behavior: the layer Audio switch controls sound output,
audio and video layer solo groups remain independent, Audio Levels default to 0 dB, and positive or
negative decibel values raise or lower amplitude. Time Stretch redistributes source audio across the
new duration, while reverse is evaluated from source time rather than playback history. Preview audio
starts from the requested timeline time, follows loop/seek/pause, and can clip when summed above the
output range. References:

- [Adobe: Layers and switches](https://helpx.adobe.com/ca/after-effects/using/layers.html)
- [Adobe: Layer properties and Audio Levels](https://helpx.adobe.com/uk/after-effects/using/layer-properties.html)
- [Adobe: Time stretching and time remapping](https://helpx.adobe.com/sg/after-effects/desktop/animate-in-after-effects/time-stretching-and-time-remapping/time-stretching-time-remapping.html)
- [Adobe: Previewing video and audio](https://helpx.adobe.com/mena_en/after-effects/desktop/view-and-preview/preview-video-and-audio/previewing.html)
- [Adobe: Audio effects and Backwards](https://helpx.adobe.com/after-effects/using/audio-effects.html)
- [Adobe: Rendering and Audio Output](https://helpx.adobe.com/in/after-effects/desktop/render-and-export/basics-of-rendering-and-exporting/basics-rendering-exporting.html)

## Runtime contract

The `AudioContext` clock is the preview master clock. Layer nodes are built only on play, seek, loop,
or an audio-setting change and are disconnected after a short click-suppression fade; the animation
frame loop never reconstructs the graph. Decode work is deduplicated by content identity in a bounded
256 MiB/32-entry LRU. Waveform peaks use a separate bounded 16 MiB/64-entry cache and run through the
CPU scheduler. Reverse buffers have their own 128 MiB bound.

Offline mixing evaluates source time independently for every output sample. It linearly resamples
source PCM, applies L/R dB and equal-power pan, sums Float32 stereo, applies the master level, and
protects the output from clipping. MP4 export uses 48 kHz chunks capped at one second. The exact PCM
length is `round(videoFrames × frameRateDenominator / frameRateNumerator × sampleRate)`, so rates such
as 30000/1001 remain tied to the video clock without cumulative drift. FFmpeg receives video on stdin
and PCM on an independent pipe, then muxes H.264 and AAC before atomic publication.

## Capability and failure policy

WAV, MP3, AAC, M4A, OGG, and FLAC are admitted only after `decodeAudioData` succeeds and reports bounded
duration/channel/sample-rate metadata. A browser codec failure, offline linked source, invalid native
stream selection, or over-budget decode is surfaced as an explicit import/playback/export diagnostic.
Unsupported input is never accepted with a promise that later playback will work.
