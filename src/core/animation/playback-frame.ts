export interface PlaybackFrame {
  compositionId: string;
  time: number;
}

interface PlaybackFrameDelivery {
  readonly frame: PlaybackFrame;
  mediaPending: boolean;
}

const PLAYBACK_FRAME_EVENT = "aster:playback-frame";

/**
 * Window delivery survives split bundles and hot replacements of the clock module. Delivery is
 * synchronous, so the result reports whether any presenter held its previous frame because media
 * for this one is still loading.
 */
export function publishPlaybackFrame(frame: PlaybackFrame): boolean {
  const delivery: PlaybackFrameDelivery = { frame, mediaPending: false };
  window.dispatchEvent(
    new CustomEvent<PlaybackFrameDelivery>(PLAYBACK_FRAME_EVENT, { detail: delivery }),
  );
  return delivery.mediaPending;
}

/** A listener returns true when it could not present the frame because media is still loading. */
export function onPlaybackFrame(listener: (frame: PlaybackFrame) => unknown): () => void {
  const receive = (event: Event) => {
    const delivery = (event as CustomEvent<PlaybackFrameDelivery>).detail;
    if (listener(delivery.frame) === true) delivery.mediaPending = true;
  };
  window.addEventListener(PLAYBACK_FRAME_EVENT, receive);
  return () => window.removeEventListener(PLAYBACK_FRAME_EVENT, receive);
}
