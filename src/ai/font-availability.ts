/** Detect native fallback by comparing multiple generic faces. This is not a font-file inventory. */
export function checkFontAvailability(family: string) {
  if (["serif", "sans-serif", "monospace", "system-ui", "cursive", "fantasy"].includes(family))
    return { family, available: true, method: "generic-family" };
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Font measurement is unavailable");
  const sample = "mmmmWWWWii0123456789汉字";
  const available = ["serif", "sans-serif", "monospace"].some((fallback) => {
    context.font = `72px ${fallback}`;
    const baseline = context.measureText(sample).width;
    context.font = `72px ${JSON.stringify(family)}, ${fallback}`;
    return Math.abs(context.measureText(sample).width - baseline) > 0.01;
  });
  return { family, available, method: "fallback-metrics" };
}
