export function isTiffSource(name = "", mimeType = ""): boolean {
  return /\.tiff?$/i.test(name) || /^image\/(?:x-)?tiff$/i.test(mimeType.trim());
}
