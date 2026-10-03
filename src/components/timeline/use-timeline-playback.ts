import { useEffect, useRef } from "react";
import { publishPlaybackFrame } from "../../core/animation/playback-frame";
import { sharedAudioPlaybackEngine } from "../../core/audio/audio-playback-engine";
import { logger } from "../../core/logger";
import type { Composition } from "../../core/types";
import { useEditor } from "../../state/editor-store";
import type { TimelineWorkArea } from "./timeline-interactions";

/**
 * Longest playback stall for loading media. A frame that never becomes ready (rather than failing,
 * which presents a placeholder) must not freeze playback forever.
 */
const MAX_MEDIA_STALL_MS = 10_000;

/**
 * UI values are sampled at 10 Hz; presentation and audio retain their own clocks. When the preview
 * holds a frame because its media is still loading, the clock and audio pause on that frame and
 * resume from it once it presents, so playback never runs ahead of what the preview can show.
 */
export function usePlayback(composition: Composition, workArea: TimelineWorkArea) {
  const { state, dispatch } = useEditor();
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    if (!state.playing) return;
    const initialTime =
      latest.current.currentTime >= workArea.start && latest.current.currentTime < workArea.end
        ? latest.current.currentTime
        : workArea.start;
    let frame = 0;
    let disposed = false;
    let seekRevision = latest.current.seekRevision;
    let presentedTime = initialTime;
    let lastUiUpdate = -Infinity;
    let audioClock = false;
    let fallbackAnchorTime = initialTime;
    let fallbackAnchorHost = performance.now();
    let stall: { time: number; since: number } | undefined;
    let stallsAllowed = true;
    const schedule = () => {
      frame = requestAnimationFrame(() => void tick());
    };
    const restart = async (time: number) => {
      try {
        await sharedAudioPlaybackEngine.play(state.project, composition, time, workArea.end);
        audioClock = true;
      } catch (error) {
        audioClock = false;
        fallbackAnchorTime = time;
        fallbackAnchorHost = performance.now();
        logger.warn("audio", "fallback_monotonic_clock", undefined, error);
      }
    };
    const tick = async () => {
      if (disposed) return;
      if (seekRevision !== latest.current.seekRevision) {
        seekRevision = latest.current.seekRevision;
        stall = undefined;
        presentedTime = Math.max(
          workArea.start,
          Math.min(workArea.end - 1 / 240, latest.current.currentTime),
        );
        await restart(presentedTime);
        if (!disposed) schedule();
        return;
      }
      if (stall) {
        const held = publishPlaybackFrame({ compositionId: composition.id, time: stall.time });
        const expired = performance.now() - stall.since >= MAX_MEDIA_STALL_MS;
        if (held && !expired) {
          schedule();
          return;
        }
        if (held) {
          stallsAllowed = false;
          logger.warn("playback", "media_stall_expired", { time: stall.time });
        }
        presentedTime = stall.time;
        stall = undefined;
        await restart(presentedTime);
        if (!disposed) schedule();
        return;
      }
      const predicted = audioClock
        ? sharedAudioPlaybackEngine.compositionTime()
        : Math.min(
            workArea.end,
            fallbackAnchorTime + (performance.now() - fallbackAnchorHost) / 1000,
          );
      presentedTime = predicted >= workArea.end - 1 / 240 ? workArea.start : predicted;
      const held = publishPlaybackFrame({ compositionId: composition.id, time: presentedTime });
      const now = performance.now();
      if (held && stallsAllowed) {
        sharedAudioPlaybackEngine.pause();
        stall = { time: presentedTime, since: now };
        lastUiUpdate = now;
        dispatch({ type: "setPlaybackTime", time: presentedTime });
        schedule();
        return;
      }
      if (now - lastUiUpdate >= 100 || presentedTime === workArea.start) {
        lastUiUpdate = now;
        dispatch({ type: "setPlaybackTime", time: presentedTime });
      }
      if (presentedTime === workArea.start && predicted >= workArea.end - 1 / 240)
        await restart(workArea.start);
      if (!disposed) schedule();
    };
    void restart(initialTime).then(() => {
      if (!disposed) schedule();
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      sharedAudioPlaybackEngine.pause();
      if (latest.current.project === state.project && latest.current.seekRevision === seekRevision)
        dispatch({ type: "setPlaybackTime", time: presentedTime });
    };
  }, [composition, dispatch, state.playing, state.project, workArea.end, workArea.start]);
}
