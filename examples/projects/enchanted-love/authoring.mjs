// Small authoring helpers for native Aster layers and reusable compositions.
let serial = 0;
export const id = (prefix = "element") => `${prefix}-${++serial}`;
export const constant = (value) => ({ mode: "static", value });
export const ease = [0.42, 0, 0.58, 1];
export const out = [0.16, 1, 0.3, 1];
export const linear = [0, 0, 1, 1];
export const palette = {
  black: "#181818",
  cream: "#eff6bf",
  green: "#12d999",
  turquoise: "#0db994",
  teal: "#0c8b8e",
  blue: "#0c6b89",
  shadow: "#10a48d",
};
export function rgba(hex, alpha = 1) {
  return [
    ...hex.match(/[a-f\d]{2}/gi).map((pair) => {
      const y = Number.parseInt(pair, 16) / 255;
      const a = 2.43 * y - 2.51,
        b = 0.59 * y - 0.03;
      return (-b - Math.sqrt(b * b - 4 * a * 0.14 * y)) / (2 * a);
    }),
    alpha,
  ];
}
export function track(entries, easing = ease) {
  if (typeof entries === "number") return constant(entries);
  return {
    mode: "animated",
    keyframes: entries.map(([time, value, curve]) => ({
      id: id("key"),
      time,
      value,
      interpolation: curve === "hold" ? "step" : "bezier",
      ...(curve === "hold" ? {} : { easing: curve ?? easing }),
    })),
  };
}
export function transform(x = 0, y = 0, w = 100, h = 100) {
  return {
    position: [constant(x), constant(y), constant(0)],
    rotation: [constant(0), constant(0), constant(0)],
    scale: [constant(100), constant(100), constant(100)],
    anchor: [constant(w / 2), constant(h / 2), constant(0)],
    opacity: constant(100),
  };
}
export function layer(name, kind, width = 100, height = 100) {
  return {
    id: id("layer"),
    name,
    kind,
    visible: true,
    solo: false,
    locked: false,
    motionBlur: false,
    threeDimensional: false,
    inPoint: 0,
    outPoint: 130.1,
    blendMode: "normal",
    color: [1, 1, 1, 1],
    size: [width, height],
    transform: transform(0, 0, width, height),
    effects: [],
  };
}
export function comp(name, width = 1280, height = 848, duration = 130.1) {
  return {
    id: id("comp"),
    name,
    width,
    height,
    duration,
    frameRate: { numerator: 30, denominator: 1 },
    workArea: { start: 0, end: duration },
    background: [0, 0, 0, 0],
    motionBlur: {
      enabled: false,
      shutterAngle: 180,
      shutterPhase: -90,
      samplesPerFrame: 4,
      adaptiveSampleLimit: 8,
    },
    layers: [],
  };
}
export function place(item, x, y, scale = 100, rotation = 0) {
  item.transform.position = [track(x), track(y), constant(0)];
  item.transform.scale = [track(scale), track(scale), constant(100)];
  item.transform.rotation[2] = track(rotation);
  return item;
}
export function during(item, start, end) {
  item.inPoint = start;
  item.outPoint = end;
  return item;
}
export function shapeStyle(kind) {
  return {
    kind,
    roundness: 0,
    strokeWidth: 0,
    strokeColor: [0, 0, 0, 0],
    fillMode: "solid",
    gradientColor: [0, 0, 0, 1],
    gradientAngle: 0,
    dashLength: 0,
    dashGap: 0,
    lineCap: "round",
    lineJoin: "round",
  };
}
export function rect(name, x, y, width, height, fill, radius = 0) {
  const item = place(layer(name, "shape", width, height), x, y);
  item.color = rgba(fill);
  item.shape = { ...shapeStyle("rectangle"), roundness: radius };
  return item;
}
export function ellipse(name, x, y, width, height, fill) {
  const item = rect(name, x, y, width, height, fill);
  item.shape.kind = "ellipse";
  return item;
}
// Coordinates are in local pixels. Optional tangent offsets retain a small, readable Bezier path.
export function vector(name, vertices, fill, { closed = true, stroke, strokeWidth = 0 } = {}) {
  const unit = Math.max(100, ...vertices.flatMap(([x, y]) => [Math.abs(x) / 8, Math.abs(y) / 8]));
  const item = layer(name, "shape", unit, unit);
  item.color = fill ? rgba(fill) : [0, 0, 0, 0];
  item.shape = {
    ...shapeStyle("bezier"),
    strokeWidth,
    strokeColor: stroke ? rgba(stroke) : [0, 0, 0, 0],
    path: {
      closed,
      vertices: vertices.map(([x, y, incoming = [0, 0], outgoing = [0, 0]]) => ({
        position: [x / unit, y / unit],
        inTangent: incoming.map((v) => v / unit),
        outTangent: outgoing.map((v) => v / unit),
      })),
    },
  };
  return item;
}
export function line(name, points, stroke, width) {
  return vector(name, points, null, { closed: false, stroke, strokeWidth: width });
}
export function instance(source, name = source.name) {
  const item = layer(name, "precomposition", source.width, source.height);
  item.sourceCompositionId = source.id;
  return item;
}
export function parent(item, joint) {
  item.parentId = joint.id;
  return item;
}
export function joint(name, x, y, rotation = 0, ancestor) {
  const item = place(layer(name, "null"), x, y, 100, rotation);
  if (ancestor) parent(item, ancestor);
  return item;
}
export function background(composition, fill) {
  composition.background = rgba(fill);
  composition.layers.push(
    rect(
      "Background",
      composition.width / 2,
      composition.height / 2,
      composition.width,
      composition.height,
      fill,
    ),
  );
}
export function animate(item, property, entries, easing = ease) {
  const [group, axis] = property.split(".");
  if (axis === undefined) item.transform[group] = track(entries, easing);
  else item.transform[group][Number(axis)] = track(entries, easing);
  return item;
}
export function effect(type, parameters, name = type, mask) {
  return { id: id("effect"), type, name, enabled: true, parameters, ...(mask ? { mask } : {}) };
}
export function overlay(fill, mask) {
  const channels = rgba(fill).slice(0, 3);
  const intensity = Math.max(1, ...channels);
  const color = channels.reduce((packed, c) => packed * 256 + Math.round((c / intensity) * 255), 0);
  return effect(
    "color-overlay",
    { color, intensity, opacity: 100, blendMode: 0 },
    "Silhouette",
    mask,
  );
}
export function text(
  name,
  content,
  x,
  y,
  width,
  height,
  size,
  fill,
  font = "Segoe Print",
  tracking = 0,
) {
  const item = place(layer(name, "text", width, height), x, y);
  item.text = content;
  // Canvas text is sampled from an sRGB texture; encode the scene-linear paint once.
  item.color = rgba(fill).map((v, i) =>
    i === 3 ? v : v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055,
  );
  item.textStyle = {
    fontFamily: font,
    fontSize: size,
    fontWeight: 400,
    alignment: "center",
    tracking,
    leading: size * 1.2,
    strokeWidth: 0,
    strokeColor: [0, 0, 0, 0],
  };
  return item;
}

// Continuous tangents at a handful of layout landmarks avoid a stop at every key.
export function continuous(points) {
  const slopes = points.slice(1).map(([t, v], i) => (v - points[i][1]) / (t - points[i][0]));
  const tangent = (i) =>
    i === 0 ? slopes[0] : i === points.length - 1 ? slopes.at(-1) : (slopes[i - 1] + slopes[i]) / 2;
  return points.map(([t, v], i) => {
    const slope = slopes[i];
    const clamp = (x) => Math.max(0, Math.min(1, x));
    return [
      t,
      v,
      slope
        ? [1 / 3, clamp(tangent(i) / slope / 3), 2 / 3, 1 - clamp(tangent(i + 1) / slope / 3)]
        : undefined,
    ];
  });
}
