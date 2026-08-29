export type GraphEvaluator = (time: number) => number;

export interface GraphSamplingRequest {
  /** Time-addressable property evaluator. Time is expressed in seconds. */
  evaluate: GraphEvaluator;
  /** Optional analytic derivative. Its result must be expressed in value/second. */
  evaluateSpeed?: GraphEvaluator;
  /** Inclusive visible interval, in seconds. */
  startTime: number;
  /** Inclusive visible interval, in seconds. */
  endTime: number;
  /** Horizontal display budget in physical or CSS pixels. */
  pixelWidth: number;
  /** Sampling density within the pixel budget. Defaults to one sample per pixel. */
  samplesPerPixel?: number;
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

/**
 * Samples an arbitrary time-addressable property without tying curve fidelity to a fixed count.
 * The visible pixel budget controls allocation while the visible time span controls sample spacing.
 */
export function sampleGraph(request: GraphSamplingRequest): GraphSampleBuffer {
  validateRequest(request);
  const samplesPerPixel = request.samplesPerPixel ?? DEFAULT_SAMPLES_PER_PIXEL;
  const maxSamples = request.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const duration = request.endTime - request.startTime;
  const count = graphSampleCount(duration, request.pixelWidth, samplesPerPixel, maxSamples);
  const target = prepareTarget(request.target, count);
  target.count = count;
  target.startTime = request.startTime;
  target.endTime = request.endTime;
  target.timeStep = count > 1 ? duration / (count - 1) : 0;

  const validValues = target.validity;
  validValues.fill(0, 0, count);
  let firstFiniteIndex = -1;
  let previousFiniteValue = 0;
  for (let index = 0; index < count; index += 1) {
    const progress = count > 1 ? index / (count - 1) : 0;
    const time = request.startTime + duration * progress;
    const value = request.evaluate(time);
    target.times[index] = time;
    if (Number.isFinite(value)) {
      target.values[index] = value;
      validValues[index] = 1;
      previousFiniteValue = value;
      if (firstFiniteIndex < 0) firstFiniteIndex = index;
    } else {
      target.values[index] = previousFiniteValue;
    }
  }

  // Leading invalid evaluations cannot use a preceding value, so extend the first finite result.
  if (firstFiniteIndex > 0)
    target.values.fill(target.values[firstFiniteIndex], 0, firstFiniteIndex);
  else if (firstFiniteIndex < 0) target.values.fill(0, 0, count);

  if (request.evaluateSpeed) {
    for (let index = 0; index < count; index += 1) {
      const speed = request.evaluateSpeed(target.times[index]);
      target.speeds[index] = finiteOrZero(speed);
    }
  } else {
    sampleNumericalSpeeds(target, validValues);
  }
  return target;
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
  if (!Number.isFinite(request.startTime) || !Number.isFinite(request.endTime))
    throw new RangeError("Graph sampling times must be finite");
  if (request.endTime < request.startTime)
    throw new RangeError("Graph sampling end time must not precede start time");
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
