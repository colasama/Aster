export interface SequenceFileLike {
  name: string;
  size: number;
  lastModified: number;
  type: string;
}

export interface ImageSequenceFrame<FileType extends SequenceFileLike = SequenceFileLike> {
  frame: number;
  file: FileType;
}

export interface ImageSequenceSelection<FileType extends SequenceFileLike = SequenceFileLike> {
  pattern: string;
  prefix: string;
  extension: string;
  padding: number;
  startFrame: number;
  endFrame: number;
  frames: readonly ImageSequenceFrame<FileType>[];
  missingFrames: readonly number[];
}

const MAX_SEQUENCE_FILES = 100_000;
const NUMBERED_FILE = /^(.*?)(\d+)(\.[^.]+)$/;

export function detectImageSequence<FileType extends SequenceFileLike>(
  files: readonly FileType[],
  selectedName?: string,
): ImageSequenceSelection<FileType> {
  if (files.length < 1 || files.length > MAX_SEQUENCE_FILES)
    throw new Error("Image sequence must contain between 1 and 100000 files");
  const selected = selectedName ? files.find((file) => file.name === selectedName) : files[0];
  if (!selected) throw new Error("Selected image sequence file is unavailable");
  const seed = numberedName(selected.name);
  const frames: ImageSequenceFrame<FileType>[] = [];
  const seen = new Set<number>();
  for (const file of files) {
    const candidate = numberedName(file.name, false);
    if (
      !candidate ||
      candidate.prefix !== seed.prefix ||
      candidate.extension.toLowerCase() !== seed.extension.toLowerCase() ||
      candidate.padding !== seed.padding
    )
      continue;
    if (seen.has(candidate.frame))
      throw new Error(`Image sequence frame ${candidate.frame} is duplicated`);
    seen.add(candidate.frame);
    frames.push({ frame: candidate.frame, file });
  }
  frames.sort(
    (left, right) => left.frame - right.frame || left.file.name.localeCompare(right.file.name),
  );
  if (frames.length < 1) throw new Error("No files match the selected image sequence pattern");
  const startFrame = frames[0]?.frame ?? 0;
  const endFrame = frames[frames.length - 1]?.frame ?? startFrame;
  const missingFrames: number[] = [];
  for (let frame = startFrame; frame <= endFrame; frame += 1)
    if (!seen.has(frame)) missingFrames.push(frame);
  return {
    pattern: `${seed.prefix}[${"#".repeat(seed.padding)}]${seed.extension}`,
    prefix: seed.prefix,
    extension: seed.extension,
    padding: seed.padding,
    startFrame,
    endFrame,
    frames,
    missingFrames,
  };
}

export function sequenceFrameAtTime(
  sequence: Pick<ImageSequenceSelection, "startFrame" | "endFrame">,
  time: number,
  frameRate: { numerator: number; denominator: number },
  loop = false,
): number {
  const numerator = safeInteger(frameRate.numerator, 1);
  const denominator = safeInteger(frameRate.denominator, 1);
  const elapsedFrames = Math.max(
    0,
    Math.floor((Math.max(0, time) * numerator) / denominator + 1e-9),
  );
  const length = Math.max(1, sequence.endFrame - sequence.startFrame + 1);
  return loop
    ? sequence.startFrame + (elapsedFrames % length)
    : Math.min(sequence.endFrame, sequence.startFrame + elapsedFrames);
}

function numberedName(name: string): {
  prefix: string;
  extension: string;
  padding: number;
  frame: number;
};
function numberedName(
  name: string,
  required: true,
): { prefix: string; extension: string; padding: number; frame: number };
function numberedName(
  name: string,
  required: false,
): { prefix: string; extension: string; padding: number; frame: number } | undefined;
function numberedName(
  name: string,
  required = true,
): { prefix: string; extension: string; padding: number; frame: number } | undefined {
  const match = NUMBERED_FILE.exec(name);
  if (!match) {
    if (required) throw new Error("Image sequence filenames must end with a padded frame number");
    return undefined;
  }
  const digits = match[2] as string;
  const frame = Number(digits);
  if (!Number.isSafeInteger(frame)) throw new Error("Image sequence frame number is invalid");
  return {
    prefix: match[1] as string,
    extension: match[3] as string,
    padding: digits.length,
    frame,
  };
}

function safeInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
