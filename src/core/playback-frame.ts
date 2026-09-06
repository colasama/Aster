export interface PlaybackFrame {
  compositionId: string;
  time: number;
}

const PLAYBACK_FRAME_EVENT = "aster:playback-frame";

/** Window delivery survives split bundles and hot replacements of the clock module. */
export function publishPlaybackFrame(frame: PlaybackFrame): void {
  window.dispatchEvent(new CustomEvent<PlaybackFrame>(PLAYBACK_FRAME_EVENT, { detail: frame }));
}

export function onPlaybackFrame(listener: (frame: PlaybackFrame) => void): () => void {
  const receive = (event: Event) => listener((event as CustomEvent<PlaybackFrame>).detail);
  window.addEventListener(PLAYBACK_FRAME_EVENT, receive);
  return () => window.removeEventListener(PLAYBACK_FRAME_EVENT, receive);
}
