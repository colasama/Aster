export interface PlaybackFrame {
  compositionId: string;
  time: number;
}

const listeners = new Set<(frame: PlaybackFrame) => void>();

/** Presentation clock: GPU frames and playheads do not wait for a React commit. */
export function publishPlaybackFrame(frame: PlaybackFrame): void {
  for (const listener of listeners) listener(frame);
}

export function onPlaybackFrame(listener: (frame: PlaybackFrame) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
