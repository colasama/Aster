import { comp, continuous } from "./authoring.mjs";
import {
  animate,
  during,
  effect,
  ellipse,
  joint,
  keyPose,
  line,
  linear,
  P,
  parent,
  place,
  prop,
  rect,
  rgba,
  track,
  vector,
} from "./scenes.mjs";

// A repeated strip grows from its left edge; width and centre share one curve.
function bands(c, name, fill, { start, end, angles, spacing, widths, count = 35 }) {
  const root = joint(name, 640, 424);
  const strip = parent(
    vector(
      "Repeated strip",
      [
        [0, -1300],
        [0, -1300],
        [0, 1300],
        [0, 1300],
      ],
      fill,
    ),
    root,
  );
  strip.shape.morph = {
    target: vector(
      "Open strip",
      [
        [0, -1300],
        [100, -1300],
        [100, 1300],
        [0, 1300],
      ],
      fill,
    ).shape.path,
    progress: track(widths),
  };
  strip.cloner = {
    distribution: { kind: "grid", count: [count, 1, 1], spacing: [100, 0, 0] },
    effectors: [],
  };
  animate(root, "rotation.2", angles);
  animate(root, "scale.0", spacing);
  c.layers.push(root, during(strip, start, end));
  return strip;
}

function tangentChain(b, c, name, beats, { start, end, symbols = false }) {
  // Every centre is derived from adjacent radii. Shared easing preserves tangency between keys.
  const positions = beats.map(([time, centre, radii, curve]) => {
    const x = [0, 0, centre, 0, 0];
    for (let i = 1; i >= 0; i--) x[i] = x[i + 1] - radii[i + 1] - radii[i];
    for (let i = 3; i < 5; i++) x[i] = x[i - 1] + radii[i - 1] + radii[i];
    return { time, radii, x, curve };
  });
  const discs = [];
  for (let i = 0; i < 5; i++) {
    const disk = during(
      b.circle(c, 640, 424, 200, i % 2 ? P.blue : P.teal, `${name} · disc ${i + 1}`),
      start,
      end,
    );
    keyPose(disk, {
      "position.0": positions.map((k) => [k.time, k.x[i], k.curve]),
      "scale.0": positions.map((k) => [k.time, k.radii[i], k.curve]),
      "scale.1": positions.map((k) => [k.time, k.radii[i] * (i === 2 ? 1 : 0.96), k.curve]),
    });
    discs.push(disk);
    if (symbols && (i === 0 || i === 4)) {
      const icon = during(
        b.tint(b.add(c, i === 0 ? b.props.heart : b.props.crown), P.green),
        start,
        end,
      );
      keyPose(icon, {
        "position.0": positions.map((k) => [k.time, k.x[i], k.curve]),
        "scale.0": positions.map((k) => [k.time, k.radii[i] * 0.89, k.curve]),
        "scale.1": positions.map((k) => [k.time, k.radii[i] * 0.89, k.curve]),
      });
    }
  }
  return discs;
}

function circleChain(b) {
  const c = b.scene("06 · Tangent circles and symbols", 22.7, 755 / 30, P.green);
  bands(c, "Compressing stripe field", P.turquoise, {
    start: 1.3,
    end: c.duration,
    angles: 0,
    count: 101,
    spacing: [
      [1.3, 90],
      [59 / 30, 90],
      [65 / 30, 64],
      [73 / 30, 26],
    ],
    widths: [
      [1.3, 25],
      [59 / 30, 48],
      [74 / 30, 48],
    ],
  });
  const split = rect("Moving palette boundary", 0, 424, 1800, 1200, P.turquoise);
  animate(split, "position.0", [
    [0, 1375, [0.15, 0.65, 0.3, 1]],
    [13 / 30, 1630],
    [21 / 30, 1581, [0.16, 0.8, 0.3, 1]],
    [33 / 30, 1274],
    [36 / 30, 1522, [0.15, 0.7, 0.3, 1]],
    [40 / 30, 1690],
    [58 / 30, 1770],
    [59 / 30, 2360],
  ]);
  c.layers.push(split);
  const chain = tangentChain(
    b,
    c,
    "Breathing chain",
    [
      [0, 624, [185, 57, 191, 166, 93], [0.16, 0.7, 0.3, 1]],
      [13 / 30, 666.5, [254, 26.5, 133.5, 235.5, 27]],
      [21 / 30, 663, [249, 29, 139, 229, 33], [0.16, 0.8, 0.3, 1]],
      [33 / 30, 658.5, [122, 206, 38.5, 136, 179]],
      [34 / 30, 658.5, [122, 206, 38.5, 136, 179], [0.16, 0.82, 0.32, 1]],
      [58 / 30, 620, [39, 104, 352, 34, 139]],
      [59 / 30, 620, [39, 104, 352, 34, 139]],
    ],
    { start: 0, end: 59 / 30 },
  );
  const splitDisc = comp("Circle · crossing blue half", 1280, 848, c.duration);
  const blue = structuredClone(chain[2]);
  blue.id += "-blue-half";
  blue.color = rgba(P.blue);
  splitDisc.layers.push(blue);
  b.supporting.push(splitDisc);
  const clipped = during(b.add(c, splitDisc), 39 / 30, 59 / 30);
  clipped.timeOffset = 39 / 30;
  const wipe = effect("linear-wipe", { completion: 50, angle: 0, feather: 0 });
  wipe.parameterKeyframes = {
    completion: track([
      [39 / 30, 47.9],
      [49 / 30, 55],
      [58 / 30, 53.7],
    ]).keyframes,
  };
  clipped.effects.push(wipe);
  tangentChain(
    b,
    c,
    "Symbol chain",
    [
      [59 / 30, 644, [185, 62, 190, 36, 210], [0.16, 0.8, 0.3, 1]],
      [65 / 30, 640, [257, 39, 90, 51, 250]],
      [68 / 30, 640, [257, 39, 85, 51, 250], [0.6, 0, 1, 0.5]],
      [73 / 30, 640, [211, 3, 6, 3, 211]],
    ],
    { start: 59 / 30, end: c.duration, symbols: true },
  );
}

function spotlightEntry(b) {
  const c = b.scene("07 · Girl and frog in the spotlight", 755 / 30, 832 / 30, P.teal);
  const tableau = comp("Spotlight · circular tableau", 1280, 848, c.duration);
  const actors = comp("Spotlight · shared actors", 1280, 848, c.duration);
  const girl = prop(b.characters.girls.spotlight, 587, 497, 102);
  animate(girl, "position.0", [
    [0, 550],
    [3 / 30, 587],
  ]);
  const frog = prop(b.characters.frog, 700, 326, 84);
  keyPose(frog, {
    "position.0": [
      [0, 746],
      [3 / 30, 700],
      [0.85, 704],
      [1.45, 775],
      [c.duration, 815],
    ],
    "position.1": [
      [0, 326],
      [0.85, 326],
      [1.45, 656],
      [c.duration, 762],
    ],
    "rotation.2": [
      [0, -8],
      [0.85, 0],
      [1.6, 50],
    ],
  });
  actors.layers.push(girl, frog);
  b.supporting.push(actors);
  const zoom = [
    [0, 123, "hold"],
    [1 / 30, 44, [0.35, 0, 0.5, 1]],
    [5 / 30, 117, [0.15, 0.6, 0.3, 1]],
    [10 / 30, 97],
    [c.duration, 100],
  ];
  const counterZoom = prop(actors, 640, 424);
  for (const axis of ["scale.0", "scale.1"]) animate(counterZoom, axis, zoom);
  counterZoom.expressions = { "scale.0": "10000/value", "scale.1": "10000/value" };
  b.spotlight(tableau, [counterZoom]);
  const rim = ellipse("Light rim", 640, 424, 520, 520, P.green);
  rim.color = [0, 0, 0, 0];
  rim.shape.strokeColor = rgba(P.cream);
  rim.shape.strokeWidth = 2.5;
  tableau.layers.push(rim);
  b.supporting.push(tableau);
  const item = b.add(c, tableau);
  for (const axis of ["scale.0", "scale.1"]) animate(item, axis, zoom);
  for (const [start, end, fill] of [
    [0, 1 / 30, P.cream],
    [1 / 30, 3 / 30, P.green],
  ]) {
    const flash = b.tint(during(b.add(c, actors), start, end), fill);
    flash.timeOffset = start;
  }
}

function motifOrbit(b) {
  const c = b.scene("08 · Dots, symbols, parentheses", 832 / 30, 907 / 30, P.green);
  const widths = [
    [0, 0, [0.25, 0.5, 0.5, 0.8]],
    [0.3, 29.7],
    [0.7, 49],
    [1.3, 66],
    [1.866666667, 100],
  ];
  const spacing = continuous([
    [0, 176],
    [0.6, 173],
    [1.2, 157],
    [1.6, 132],
    [1.866666667, 105],
  ]);
  const angles = continuous([
    [0, -1],
    [0.6, 28.6],
    [1.2, 61.55],
    [1.6, 89],
    [1.866666667, 110],
  ]);
  for (const [name, bg, fill, start, end] of [
    ["Green", P.green, P.turquoise, 0, 0.6],
    ["Blue", P.blue, P.teal, 0.6, 37 / 30],
    ["Returning green", P.turquoise, P.green, 37 / 30, 56 / 30],
  ]) {
    const field = comp(`${name} · rotating bands`, 1280, 848, c.duration);
    field.layers.push(rect("Field colour", 640, 424, 1280, 848, bg));
    const strip = bands(field, "Shared band rotation", fill, {
      start: 0,
      end: c.duration,
      angles,
      spacing,
      widths,
    });
    if (start > 1)
      animate(strip, "opacity", [
        [1.4, 100],
        [1.6, 15],
        [1.733333333, 0],
      ]);
    b.supporting.push(field);
    const fieldInstance = during(b.add(c, field), start, end);
    fieldInstance.timeOffset = start;
  }
  c.layers.push(during(rect("Clear teal field", 640, 424, 1280, 848, P.teal), 56 / 30, c.duration));

  const carrier = joint("Pair · accelerating orbit", 640, 424);
  animate(carrier, "rotation.2", [
    [0, 0, [0.5, 0, 0.7, 0.4]],
    [0.6, 44, [0.333, 0.18, 0.666, 0.52]],
    [38 / 30, 250],
  ]);
  c.layers.push(carrier);
  for (const sign of [-1, 1]) {
    const actor = joint(sign < 0 ? "Upper motif" : "Lower motif", 0, 0, 0, carrier);
    animate(actor, "position.1", [
      [0, 32 * sign, [0.15, 0.55, 0.5, 0.8]],
      [0.2, 163 * sign, [0.3, 0.55, 0.7, 0.8]],
      [0.6, 227 * sign],
      [38 / 30, 266 * sign],
    ]);
    // Counter-rotation keeps each icon upright while the pair circles their shared centre.
    animate(actor, "rotation.2", [
      [0, 0, [0.5, 0, 0.7, 0.4]],
      [0.6, -44, [0.333, 0.18, 0.666, 0.52]],
      [38 / 30, -250],
    ]);
    c.layers.push(actor);
    c.layers.push(during(parent(ellipse("Orbiting dot", 0, 0, 148, 148, P.teal), actor), 0, 0.6));
    const icon = parent(
      b.tint(b.add(c, sign < 0 ? b.props.heart : b.props.crown, 0, 0, 130), P.turquoise),
      actor,
    );
    during(icon, 0.6, 37 / 30);
    for (const axis of ["scale.0", "scale.1"])
      animate(icon, axis, [
        [0.6, 68],
        [0.7, 138],
        [0.8, 126],
        [1.1, 135],
      ]);
  }
  const parentheses = joint("Pair · contracting parentheses", 640, 424);
  parentheses.expressions = { "rotation.2": "240*(time-1.266666667)+100*pow(time-1.266666667,2)" };
  c.layers.push(parentheses);
  for (const sign of [-1, 1]) {
    const arcRoot = joint("Parenthesis centre", 235 * sign, 0, 0, parentheses);
    c.layers.push(arcRoot);
    for (const [width, fill] of [
      [146, P.teal],
      [50, P.turquoise],
    ]) {
      const arc = parent(
        place(
          line(
            "Rounded parenthesis",
            [
              [-30 * sign, -130, [0, 0], [80 * sign, 100]],
              [-30 * sign, 130, [80 * sign, -100]],
            ],
            fill,
            width,
          ),
          0,
          0,
        ),
        arcRoot,
      );
      during(arc, 37 / 30, 56 / 30);
      c.layers.push(arc);
      arc.shape.morph = {
        target: vector(
          "Closed parenthesis",
          [
            [0, 0],
            [0, 0],
          ],
          null,
          { closed: false },
        ).shape.path,
        progress: track([
          [37 / 30, 0],
          [1.533333333, 5],
          [1.733333333, 55],
          [55 / 30, 100],
        ]),
      };
    }
  }
  const dots = joint("Pair · closing orbit", 640, 424);
  const t = "(time-1.866666667)";
  dots.expressions = { "rotation.2": `200*${t}+120*pow(${t},2)+800*pow(max(0,${t}-.35),2)` };
  c.layers.push(dots);
  for (const sign of [-1, 1]) {
    const dot = parent(ellipse("Closing green dot", 0, 0, 148, 148, P.green), dots);
    c.layers.push(during(dot, 56 / 30, c.duration));
    animate(dot, "position.0", [
      [56 / 30, 225 * sign, linear],
      [2.233333333, 174 * sign, [0.6, 0, 0.8, 0.3]],
      [2.5, 0],
    ]);
    for (const axis of ["scale.0", "scale.1"])
      animate(dot, axis, [
        [2.233333333, 100],
        [2.5, 70],
      ]);
  }
}

export function earlyMotifs(b) {
  circleChain(b);
  spotlightEntry(b);
  motifOrbit(b);
}
