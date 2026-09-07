/** Read the weight axis from an SFNT directory without decoding glyphs or allocating table copies. */
export function fontWeightRange(bytes: Uint8Array): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12) return;
  const signature = view.getUint32(0);
  if (signature !== 0x00010000 && signature !== 0x4f54544f) return;
  const tableCount = view.getUint16(4);
  if (12 + tableCount * 16 > view.byteLength) return;
  for (let index = 0; index < tableCount; index++) {
    const entry = 12 + index * 16;
    if (view.getUint32(entry) !== 0x66766172) continue;
    const offset = view.getUint32(entry + 8);
    const length = view.getUint32(entry + 12);
    if (length < 16 || offset + length > view.byteLength) return;
    const axesOffset = view.getUint16(offset + 4);
    const axisCount = view.getUint16(offset + 8);
    const axisSize = view.getUint16(offset + 10);
    if (axesOffset < 16 || axisSize < 20 || axesOffset + axisCount * axisSize > length) return;
    for (let axis = 0; axis < axisCount; axis++) {
      const position = offset + axesOffset + axis * axisSize;
      if (view.getUint32(position) !== 0x77676874) continue;
      const min = view.getInt32(position + 4) / 65536;
      const max = view.getInt32(position + 12) / 65536;
      if (
        Number.isInteger(min) &&
        Number.isInteger(max) &&
        min >= 100 &&
        max <= 900 &&
        min <= 400 &&
        max >= 400
      )
        return [min, max];
    }
  }
}
