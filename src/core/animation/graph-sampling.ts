export type GraphEvaluator = (time: number) => number;

export interface GraphSamplingRequest {
  /** Time-addressable property evaluator. Time is expressed in seconds. */
  evaluate: GraphEvaluator;
  /** Optional analytic derivative. Its result must be expressed in value/second. */
  evaluateSpeed?: GraphEvaluator;
  /** Optional displayed curve used only to drive screen-error subdivision. */
  adaptiveEvaluate?: GraphEvaluator;
  /** Inclusive visible interval, in seconds. */
  startTime: number;
  /** Inclusive visible interval, in seconds. */
  endTime: number;
  /** Horizontal display budget in physical or CSS pixels. */
  pixelWidth: number;
  /** Vertical display budget used to convert curve error into pixels. Defaults to 512. */
  pixelHeight?: number;
  /** Sampling density within the pixel budget. Defaults to one sample per pixel. */
  samplesPerPixel?: number;
  /** Maximum permitted curve deviation in display pixels. Defaults to 0.35. */
  adaptiveErrorPixels?: number;
  /** Times that must be sampled exactly, such as keyframes and hold boundaries. */
  breakpoints?: readonly number[];
  /** Hard allocation bound. Defaults to 16,384 samples. */
  maxSamples?: number;
  /** Reused when its typed arrays are large enough for the requested sample count. */
  target?: GraphSampleBuffer;
}

/**
 * Structure-of-arrays output for cache-friendly graph rendering. Consumers must read only `count`
 * elements. `speeds` are always expressed in value/second.
 */
export interface GraphSampleBuffer {
  count: number;
  startTime: number;
  endTime: number;
  timeStep: number;
  times: Float64Array;
  values: Float64Array;
  speeds: Float64Array;
  /** One for a finite evaluator result and zero when the corresponding value was repaired. */
  validity: Uint8Array;
}

const DEFAULT_MAX_SAMPLES = 16_384;
const DEFAULT_SAMPLES_PER_PIXEL = 1;
const DEFAULT_PIXEL_HEIGHT = 512;
const DEFAULT_ADAPTIVE_ERROR_PIXELS = 0.35;
const MAX_ADAPTIVE_DEPTH = 14;

interface SamplePoint {
  time: number;
  value: number;
  valid: boolean;
  adaptiveValue?: number;
  adaptiveValid?: boolean;
}

/**
 * Samples an arbitrary time-addressable property without tying curve fidelity to a fixed count.
 * The visible pixel budget controls allocation while the visible time span controls sample spacing.
 */
export function sampleGraph(request: GraphSamplingRequest): GraphSampleBuffer {
  validateRequest(request);
  const samplesPerPixel = request.samplesPerPixel ?? DEFAULT_SAMPLES_PER_PIXEL;
  const maxSamples = request.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const duration = request.endTime - request.startTime;
  const baseCount = graphSampleCount(duration, request.pixelWidth, samplesPerPixel, maxSamples);
  const base = sampleBasePoints(request, baseCount, maxSamples);
  const points = refineGraphPoints(request, base, maxSamples);
  const target = prepareTarget(request.target, points.length);
  target.count = points.length;
  target.startTime = request.startTime;
  target.endTime = request.endTime;
  target.timeStep = uniformTimeStep(points);

  const validValues = target.validity;
  validValues.fill(0, 0, points.length);
  let firstFiniteIndex = -1;
  let previousFiniteValue = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index] as SamplePoint;
    target.times[index] = point.time;
    if (point.valid) {
      target.values[index] = point.value;
      validValues[index] = 1;
      previousFiniteValue = point.value;
      if (firstFiniteIndex < 0) firstFiniteIndex = index;
    } else {
      target.values[index] = previousFiniteValue;
    }
  }

  // Leading invalid evaluations cannot use a preceding value, so extend the first finite result.
  if (firstFiniteIndex > 0)
    target.values.fill(target.values[firstFiniteIndex], 0, firstFiniteIndex);
  else if (firstFiniteIndex < 0) target.values.fill(0, 0, points.length);

  if (request.evaluateSpeed) {
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index] as SamplePoint;
      const speed =
        request.adaptiveEvaluate === request.evaluateSpeed && point.adaptiveValid
          ? (point.adaptiveValue ?? 0)
          : request.evaluateSpeed(target.times[index]);
      target.speeds[index] = finiteOrZero(speed);
    }
  } else {
    sampleNumericalSpeeds(target, validValues);
  }
  return target;
}

function sampleBasePoints(
  request: GraphSamplingRequest,
  baseCount: number,
  maxSamples: number,
): SamplePoint[] {
  const duration = request.endTime - request.startTime;
  const times = new Set<number>();
  for (let index = 0; index < baseCount; index += 1) {
    const progress = baseCount > 1 ? index / (baseCount - 1) : 0;
    times.add(request.startTime + duration * progress);
  }
  for (const breakpoint of request.breakpoints ?? []) {
    if (times.size >= maxSamples) break;
    if (!Number.isFinite(breakpoint)) continue;
    if (breakpoint < request.startTime || breakpoint > request.endTime) continue;
    times.add(breakpoint);
  }
  return [...times]
    .sort((left, right) => left - right)
    .map((time) => evaluatePoint(request.evaluate, time, request.adaptiveEvaluate));
}

function refineGraphPoints(
  request: GraphSamplingRequest,
  base: readonly SamplePoint[],
  maxSamples: number,
): SamplePoint[] {
  if (base.length < 2 || base.length >= maxSamples) return [...base];
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const point of base) {
    const sample = adaptivePoint(point, Boolean(request.adaptiveEvaluate));
    if (!sample.valid) continue;
    minimum = Math.min(minimum, sample.value);
    maximum = Math.max(maximum, sample.value);
  }
  const valueSpan = Math.max(
    1e-9,
    Number.isFinite(minimum) && Number.isFinite(maximum) ? maximum - minimum : 1,
  );
  const pixelHeight = request.pixelHeight ?? DEFAULT_PIXEL_HEIGHT;
  const errorPixels = request.adaptiveErrorPixels ?? DEFAULT_ADAPTIVE_ERROR_PIXELS;
  const tolerance = (valueSpan / pixelHeight) * errorPixels;
  let remaining = maxSamples - base.length;
  const result: SamplePoint[] = [base[0] as SamplePoint];
  for (let index = 0; index < base.length - 1; index += 1) {
    const start = base[index] as SamplePoint;
    const end = base[index + 1] as SamplePoint;
    const refined: SamplePoint[] = [];
    remaining = refineSegment(
      request.evaluate,
      request.adaptiveEvaluate,
      start,
      end,
      tolerance,
      0,
      remaining,
      refined,
    );
    result.push(...refined, end);
  }
  return result;
}

function refineSegment(
  evaluate: GraphEvaluator,
  adaptiveEvaluate: GraphEvaluator | undefined,
  start: SamplePoint,
  end: SamplePoint,
  tolerance: number,
  depth: number,
  remaining: number,
  output: SamplePoint[],
): number {
  if (remaining <= 0 || depth >= MAX_ADAPTIVE_DEPTH) return remaining;
  const duration = end.time - start.time;
  if (duration <= Number.EPSILON) return remaining;
  const middle = evaluatePoint(evaluate, start.time + duration * 0.5, adaptiveEvaluate);
  const quarter = evaluatePoint(evaluate, start.time + duration * 0.25, adaptiveEvaluate);
  const threeQuarter = evaluatePoint(evaluate, start.time + duration * 0.75, adaptiveEvaluate);
  const adaptive = Boolean(adaptiveEvaluate);
  const adaptiveStart = adaptivePoint(start, adaptive);
  const adaptiveEnd = adaptivePoint(end, adaptive);
  const adaptiveMiddle = adaptivePoint(middle, adaptive);
  const adaptiveQuarter = adaptivePoint(quarter, adaptive);
  const adaptiveThreeQuarter = adaptivePoint(threeQuarter, adaptive);
  const needsRefinement =
    !adaptiveStart.valid ||
    !adaptiveEnd.valid ||
    !adaptiveMiddle.valid ||
    !adaptiveQuarter.valid ||
    !adaptiveThreeQuarter.valid ||
    pointDeviation(adaptiveQuarter, adaptiveStart, adaptiveEnd, 0.25) > tolerance ||
    pointDeviation(adaptiveMiddle, adaptiveStart, adaptiveEnd, 0.5) > tolerance ||
    pointDeviation(adaptiveThreeQuarter, adaptiveStart, adaptiveEnd, 0.75) > tolerance;
  if (!needsRefinement) return remaining;
  const remainingAfterMiddle = remaining - 1;
  let available = refineSegment(
    evaluate,
    adaptiveEvaluate,
    start,
    middle,
    tolerance,
    depth + 1,
    remainingAfterMiddle,
    output,
  );
  output.push(middle);
  available = refineSegment(
    evaluate,
    adaptiveEvaluate,
    middle,
    end,
    tolerance,
    depth + 1,
    available,
    output,
  );
  return available;
}

function pointDeviation(
  point: Pick<SamplePoint, "value" | "valid">,
  start: Pick<SamplePoint, "value" | "valid">,
  end: Pick<SamplePoint, "value" | "valid">,
  progress: number,
): number {
  if (!point.valid || !start.valid || !end.valid) return Number.POSITIVE_INFINITY;
  const linear = start.value * (1 - progress) + end.value * progress;
  return Math.abs(point.value - linear);
}

function evaluatePoint(
  evaluate: GraphEvaluator,
  time: number,
  adaptiveEvaluate?: GraphEvaluator,
): SamplePoint {
  const value = evaluate(time);
  const valid = Number.isFinite(value);
  if (!adaptiveEvaluate) return { time, value: valid ? value : 0, valid };
  const adaptiveValue = adaptiveEvaluate(time);
  const adaptiveValid = Number.isFinite(adaptiveValue);
  return {
    time,
    value: valid ? value : 0,
    valid,
    adaptiveValue: adaptiveValid ? adaptiveValue : 0,
    adaptiveValid,
  };
}

function adaptivePoint(
  point: SamplePoint,
  adaptive: boolean,
): Pick<SamplePoint, "value" | "valid"> {
  return adaptive
    ? { value: point.adaptiveValue ?? 0, valid: point.adaptiveValid === true }
    : point;
}

function uniformTimeStep(points: readonly SamplePoint[]): number {
  if (points.length < 2) return 0;
  const span = (points[points.length - 1] as SamplePoint).time - (points[0] as SamplePoint).time;
  const expected = span / (points.length - 1);
  const epsilon = Math.max(1e-12, Math.abs(expected) * 1e-9);
  for (let index = 1; index < points.length; index += 1) {
    const actual = (points[index] as SamplePoint).time - (points[index - 1] as SamplePoint).time;
    if (Math.abs(actual - expected) > epsilon) return 0;
  }
  return expected;
}

/** Returns the bounded sample count selected for a visible interval and horizontal pixel budget. */
export function graphSampleCount(
  duration: number,
  pixelWidth: number,
  samplesPerPixel = DEFAULT_SAMPLES_PER_PIXEL,
  maxSamples = DEFAULT_MAX_SAMPLES,
): number {
  if (!Number.isFinite(duration) || duration < 0)
    throw new RangeError("Graph sampling duration must be a finite non-negative number");
  if (!Number.isFinite(pixelWidth) || pixelWidth < 0)
    throw new RangeError("Graph sampling pixel width must be a finite non-negative number");
  if (!Number.isFinite(samplesPerPixel) || samplesPerPixel <= 0)
    throw new RangeError("Graph sampling density must be a finite positive number");
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 1)
    throw new RangeError("Graph sampling maximum must be a positive safe integer");
  if (duration === 0 || pixelWidth === 0 || maxSamples === 1) return 1;
  return Math.min(maxSamples, Math.max(2, Math.ceil(pixelWidth * samplesPerPixel) + 1));
}

function validateRequest(request: GraphSamplingRequest): void {
  if (typeof request.evaluate !== "function")
    throw new TypeError("Graph sampling requires a time-addressable evaluator");
  if (request.evaluateSpeed !== undefined && typeof request.evaluateSpeed !== "function")
    throw new TypeError("Graph speed evaluator must be a function");
  if (request.adaptiveEvaluate !== undefined && typeof request.adaptiveEvaluate !== "function")
    throw new TypeError("Graph adaptive evaluator must be a function");
  if (!Number.isFinite(request.startTime) || !Number.isFinite(request.endTime))
    throw new RangeError("Graph sampling times must be finite");
  if (request.endTime < request.startTime)
    throw new RangeError("Graph sampling end time must not precede start time");
  if (
    request.pixelHeight !== undefined &&
    (!Number.isFinite(request.pixelHeight) || request.pixelHeight <= 0)
  )
    throw new RangeError("Graph sampling pixel height must be a finite positive number");
  if (
    request.adaptiveErrorPixels !== undefined &&
    (!Number.isFinite(request.adaptiveErrorPixels) || request.adaptiveErrorPixels <= 0)
  )
    throw new RangeError("Graph adaptive error must be a finite positive pixel value");
  graphSampleCount(
    request.endTime - request.startTime,
    request.pixelWidth,
    request.samplesPerPixel,
    request.maxSamples,
  );
}

function prepareTarget(target: GraphSampleBuffer | undefined, count: number): GraphSampleBuffer {
  if (
    target &&
    target.times.length >= count &&
    target.values.length >= count &&
    target.speeds.length >= count &&
    target.validity.length >= count
  )
    return target;
  return {
    count,
    startTime: 0,
    endTime: 0,
    timeStep: 0,
    times: new Float64Array(count),
    values: new Float64Array(count),
    speeds: new Float64Array(count),
    validity: new Uint8Array(count),
  };
}

function sampleNumericalSpeeds(target: GraphSampleBuffer, valid: Uint8Array): void {
  const { count, speeds, times, values } = target;
  if (count === 1) {
    speeds[0] = 0;
    return;
  }
  speeds[0] = secant(times[0], values[0], valid[0], times[1], values[1], valid[1]);
  for (let index = 1; index < count - 1; index += 1) {
    if (!valid[index - 1] || !valid[index] || !valid[index + 1]) {
      speeds[index] = 0;
      continue;
    }
    const before = times[index] - times[index - 1];
    const after = times[index + 1] - times[index];
    const span = before + after;
    if (before <= 0 || after <= 0 || span <= 0) {
      speeds[index] = 0;
      continue;
    }
    // Three-point derivative for potentially non-uniform timestamps. This avoids subtracting the
    // absolute timeline origin and remains stable for fractional frame rates and zoomed intervals.
    const speed =
      (-after / (before * span)) * values[index - 1] +
      ((after - before) / (before * after)) * values[index] +
      (before / (after * span)) * values[index + 1];
    speeds[index] = finiteOrZero(speed);
  }
  speeds[count - 1] = secant(
    times[count - 2],
    values[count - 2],
    valid[count - 2],
    times[count - 1],
    values[count - 1],
    valid[count - 1],
  );
}

function secant(
  firstTime: number,
  firstValue: number,
  firstValid: number,
  secondTime: number,
  secondValue: number,
  secondValid: number,
): number {
  const duration = secondTime - firstTime;
  if (!firstValid || !secondValid || duration <= 0) return 0;
  return finiteOrZero((secondValue - firstValue) / duration);
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) && value !== 0 ? value : 0;
}
