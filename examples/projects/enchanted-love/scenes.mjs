import {
  animate,
  background,
  comp,
  constant,
  during,
  effect,
  ellipse,
  id,
  instance,
  joint,
  line,
  linear,
  out,
  overlay,
  palette as P,
  parent,
  place,
  rect,
  rgba,
  text,
  track,
  vector,
} from "./authoring.mjs";
import { prop } from "./props.mjs";

export function sceneBook(props, characters) {
  const scenes = [],
    supporting = [],
    shots = [];
  const tintedProps = new Map();
  const scene = (name, start, end, fill = P.turquoise) => {
    const c = comp(name, 1280, 848, end - start);
    if (fill) background(c, fill);
    scenes.push(c);
    shots.push({ name, start, end, composition: c.id });
    return c;
  };
  const add = (c, source, x = 640, y = 424, scale = 100, angle = 0, name) => {
    const item = prop(source, x, y, scale, angle, name);
    c.layers.push(item);
    return item;
  };
  const group = (c, name, items, fill, mask) => {
    const source = comp(name, c.width, c.height, c.duration);
    source.layers = items;
    supporting.push(source);
    const item = add(c, source);
    if (fill) item.effects.push(overlay(fill, mask));
    return item;
  };
  const circle = (c, x, y, diameter, fill, name = "Circle") => {
    const item = ellipse(name, x, y, diameter, diameter, fill);
    c.layers.push(item);
    return item;
  };
  const stripes = (c, { angle = 0, spacing = 74, width = 20, fill = P.green, travel = 0 } = {}) => {
    const root = joint("Stripe field", 640, 424, angle);
    c.layers.push(root);
    const count = Math.floor(3000 / spacing) + 1;
    const stripe = parent(
      rect("Repeated stripe", -1500 + ((count - 1) * spacing) / 2, 0, width, 2400, fill),
      root,
    );
    stripe.cloner = {
      distribution: { kind: "grid", count: [count, 1, 1], spacing: [spacing, 0, 0] },
      effectors: [],
    };
    c.layers.push(stripe);
    if (travel) root.expressions = { "position.0": `640 + ${travel}*time` };
    return root;
  };
  const orbit = (item, radius, period, phase = 0, center = [640, 424]) => {
    item.expressions = {
      "position.0": `${center[0]} + ${radius}*cos(time*${(2 * Math.PI) / period}+${phase})`,
      "position.1": `${center[1]} + ${radius}*sin(time*${(2 * Math.PI) / period}+${phase})`,
      "rotation.2": `value + time*${360 / period}`,
    };
    return item;
  };
  const shadow = (c, source, x, y, scale = 100, angle = 0, fill = P.shadow) => {
    const drop = add(
      c,
      source,
      x + (25 * scale) / 100,
      y + (40 * scale) / 100,
      scale,
      angle,
      "Cast shadow",
    );
    tint(drop, fill);
    return drop;
  };
  const tint = (item, color) => {
    const source = props.assets.find((c) => c.id === item.sourceCompositionId);
    if (source?.layers.every((l) => l.kind === "shape")) {
      const key = `${source.id}:${color}`;
      if (!tintedProps.has(key)) {
        const copy = structuredClone(source);
        copy.id = id("comp");
        copy.name = `${source.name} · ${color}`;
        for (const l of copy.layers) {
          l.id = id("layer");
          if (l.color[3]) l.color = rgba(color);
          if (l.shape.strokeColor[3]) l.shape.strokeColor = rgba(color);
        }
        supporting.push(copy);
        tintedProps.set(key, copy);
      }
      item.sourceCompositionId = tintedProps.get(key).id;
    } else item.effects.push(overlay(color));
    return item;
  };
  const morph = (c, name, from, to, start, end, fill, options = {}) => {
    const item = vector(name, from, fill, options);
    item.shape.morph = {
      target: vector(name, to, fill, options).shape.path,
      progress: track([
        [start, 0],
        [end, 100],
      ]),
    };
    c.layers.push(item);
    return item;
  };
  const spotlight = (c, actors, diameter = 520) => {
    circle(c, 640, 424, diameter, P.green, "Circular light field");
    for (let y = 240; y < 690; y += 103)
      for (let x = 438; x < 890; x += 103)
        if (Math.hypot(x - 640, y - 424) < diameter / 2 - 24)
          circle(c, x, y, 43, P.turquoise, "Spot pattern");
    return group(c, "Actors in circular light", actors, P.blue, {
      shape: "ellipse",
      center: [50, 50],
      size: [diameter / 12.8, diameter / 8.48],
      feather: 0,
      opacity: 100,
      invert: true,
    });
  };
  const doorway = (c, x = 640, y = 365, width = 235, height = 730) => {
    c.layers.push(rect("Doorway outer light", x, y, width, height, P.blue));
    c.layers.push(rect("Doorway core", x, y, width * 0.61, height, P.turquoise));
    c.layers.push(
      line(
        "Threshold",
        [
          [x - width / 2 - 24, y + height / 2],
          [x + width / 2 + 24, y + height / 2],
        ],
        P.cream,
        3,
      ),
    );
    const spark = add(c, props.sparkle, x - 35, y - 10, 110);
    spark.expressions = { "position.1": `${y - 10} + 150*sin(time*2.2)`, "rotation.2": "time*20" };
  };
  const slope = (c, color, top = [0, 620, 1280, 310]) => {
    const item = vector(
      "Sloped horizon",
      [
        [top[0], top[1]],
        [top[2], top[3]],
        [1800, 1300],
        [-600, 1300],
      ],
      color,
    );
    c.layers.push(item);
    return item;
  };
  return {
    scenes,
    supporting,
    shots,
    scene,
    add,
    group,
    circle,
    stripes,
    orbit,
    shadow,
    tint,
    morph,
    spotlight,
    doorway,
    slope,
    props,
    characters,
  };
}

export function title(c, credit = false) {
  c.layers.push(
    text(
      "Handwritten title",
      "enchanted love",
      640,
      credit ? 413 : 437,
      790,
      95,
      credit ? 57 : 43,
      credit ? P.turquoise : P.cream,
      "Segoe Print",
      credit ? 10 : 8,
    ),
  );
  if (credit)
    c.layers.push(
      text("Artist credit", "linear ring", 640, 478, 240, 46, 31, P.blue, "Agency FB", 1),
    );
}

export function keyPose(item, values) {
  for (const [path, keys] of Object.entries(values)) animate(item, path, keys);
  return item;
}

export {
  animate,
  constant,
  during,
  effect,
  ellipse,
  id,
  instance,
  joint,
  line,
  linear,
  out,
  overlay,
  P,
  parent,
  place,
  prop,
  rect,
  rgba,
  track,
  vector,
};
