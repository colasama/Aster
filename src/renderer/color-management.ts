export type Rgb = readonly [number, number, number];
export type Rgba = readonly [number, number, number, number];

export function srgbToLinear(color: Rgb): Rgb {
  return color.map(srgbChannelToLinear) as unknown as Rgb;
}

export function linearToSrgb(color: Rgb): Rgb {
  return color.map(linearChannelToSrgb) as unknown as Rgb;
}

export function srgbChannelToLinear(value: number): number {
  const bounded = Math.max(0, value);
  return bounded <= 0.04045 ? bounded / 12.92 : ((bounded + 0.055) / 1.055) ** 2.4;
}

export function linearChannelToSrgb(value: number): number {
  const bounded = Math.max(0, value);
  return bounded <= 0.0031308 ? bounded * 12.92 : 1.055 * bounded ** (1 / 2.4) - 0.055;
}

/** Matches the display transform in the WebGPU post-process shader. */
export function acesToneMap(color: Rgb): Rgb {
  return color.map((channel) => {
    const value = Math.max(0, channel);
    return Math.max(
      0,
      Math.min(1, (value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14)),
    );
  }) as unknown as Rgb;
}

export function premultiply(color: Rgba): Rgba {
  return [color[0] * color[3], color[1] * color[3], color[2] * color[3], color[3]];
}

export function unpremultiply(color: Rgba): Rgba {
  if (color[3] <= Number.EPSILON) return [0, 0, 0, 0];
  return [color[0] / color[3], color[1] / color[3], color[2] / color[3], color[3]];
}

/** Porter-Duff source-over for linear-light, premultiplied RGBA. */
export function compositePremultiplied(source: Rgba, destination: Rgba): Rgba {
  const destinationWeight = 1 - source[3];
  return [
    source[0] + destination[0] * destinationWeight,
    source[1] + destination[1] * destinationWeight,
    source[2] + destination[2] * destinationWeight,
    source[3] + destination[3] * destinationWeight,
  ];
}
