/**
 * Beat-grid helpers shared by layer, effect and text-selector expressions. With the bpm and
 * offset from analyze_beats, beat() counts beats since the grid start and beatphase() rises from
 * 0 to 1 across each beat (or each 1/division of a beat).
 */
export function beatPosition(time: number, bpm: number, offset = 0, division = 1): number {
  if (!(bpm > 0) || !(division > 0)) throw new Error("beat functions require positive bpm");
  return ((time - offset) * bpm * division) / 60;
}

export function beatIndex(time: number, bpm: number, offset?: number, division?: number): number {
  return Math.floor(beatPosition(time, bpm, offset, division));
}

export function beatPhase(time: number, bpm: number, offset?: number, division?: number): number {
  const position = beatPosition(time, bpm, offset, division);
  return position - Math.floor(position);
}
