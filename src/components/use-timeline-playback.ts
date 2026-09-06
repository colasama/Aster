import { useEffect, useRef } from "react";
import { sharedAudioPlaybackEngine } from "../core/audio-playback-engine";
import { logger } from "../core/logger";
import type { Composition } from "../core/types";
import { useEditor } from "../state/editor-store";
import type { TimelineWorkArea } from "./timeline-interactions";

/** Explicit seek revisions keep delayed UI commits from restarting the audio clock. */
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
    let audioClock = false;
    let fallbackAnchorTime = initialTime;
    let fallbackAnchorHost = performance.now();
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
        presentedTime = Math.max(
          workArea.start,
          Math.min(workArea.end - 1 / 240, latest.current.currentTime),
        );
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
      dispatch({ type: "setPlaybackTime", time: presentedTime });
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
