/** Copy validated plain wire data without serializing its immutable string values again. */
export function copyWireValue<T>(value: T): T {
  const kind = typeof value;
  if (value === null || kind === "string" || kind === "number" || kind === "boolean") return value;
  if (Array.isArray(value)) return value.map(copyWireValue) as T;
  if (typeof value !== "object") throw new Error("Wire copies require plain JSON values");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Wire copies require plain JSON values");
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const copied = copyWireValue(entry);
    // Inherited setters and non-writable properties must never intercept owned wire keys.
    if (key in Object.prototype)
      Object.defineProperty(output, key, {
        value: copied,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else output[key] = copied;
  }
  return output as T;
}
