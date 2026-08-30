const bits = new ArrayBuffer(4);
const float32 = new Float32Array(bits);
const uint32 = new Uint32Array(bits);

export function float32ToFloat16(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? 0x7bff : value < 0 ? 0xfbff : 0x7e00;
  float32[0] = Math.max(-65_504, Math.min(65_504, value));
  const source = uint32[0];
  const sign = (source >>> 16) & 0x8000;
  let exponent = ((source >>> 23) & 0xff) - 112;
  let mantissa = source & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  if (exponent >= 31) return sign | 0x7bff;
  mantissa += 0x1000;
  if ((mantissa & 0x800000) !== 0) {
    mantissa = 0;
    exponent += 1;
    if (exponent >= 31) return sign | 0x7bff;
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}
