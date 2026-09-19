import {
  animate,
  comp,
  constant,
  continuous,
  during,
  effect,
  palette as P,
  place,
  rect,
  track,
  vector,
} from "./authoring.mjs";
import { reunionScene } from "./reunion.mjs";
import { keyPose } from "./scenes.mjs";

function openingBeam(c) {
  // Two independently editable widths describe the camera's widening frustum.
  const widths = [
    [0, 2, 24],
    [0.1, 39, 153],
    [0.5, 123, 339],
    [1.3, 223, 526],
    [2.5, 297, 644],
    [3.9, 326, 693],
    [4.7, 327, 695],
  ];
  for (const [name, fill, topBorder, bottomBorder] of [
    ["Ivory beam edges", P.cream, 36, 80],
    ["Green light", P.green, 0, 0],
  ]) {
    const cone = place(
      vector(
        name,
        [
          [0, -40],
          [0, -40],
          [350, 860],
          [-350, 860],
        ],
        fill,
      ),
      636,
      0,
      100,
      0.72,
    );
    const target = vector(
      name,
      [
        [-350, -40],
        [350, -40],
        [350, 860],
        [-350, 860],
      ],
      fill,
    );
    cone.shape.morph = {
      target: target.shape.path,
      progress: track(
        continuous(
          widths.map(([t, top, bottom]) => [
            t,
            (100 * (top + topBorder)) / (bottom + bottomBorder),
          ]),
        ),
      ),
    };
    animate(
      cone,
      "scale.0",
      continuous(widths.map(([t, , bottom]) => [t, (bottom + bottomBorder) / 7])),
    );
    animate(cone, "position.0", [
      [0, 650, [0.001, 0.089, 0.203, 0.933]],
      [3.9, 636],
    ]);
    c.layers.push(cone);
  }
}

function crossingRiders(b, c) {
  const riders = comp("Turtle riders · crossing pose", 1280, 848, c.duration);
  const turtle = b.add(riders, b.props.turtle, 614, 506, 88);
  turtle.transform.scale[0] = constant(-88);
  b.add(riders, b.characters.frog, 558, 393, 46, -10);
  const girl = b.add(riders, b.characters.girls.riding, 640, 470, 88);
  animate(girl, "rotation.2", [
    [1.1, -7],
    [1.6, 0],
    [2.1, 12],
  ]);
  b.supporting.push(riders);
  const travel = comp("Turtle riders · shared crossing camera", 1280, 848, c.duration);
  const camera = b.add(travel, riders);
  keyPose(camera, {
    "position.0": continuous([
      [1.05, 1500],
      [1.3, 1010],
      [1.5, 505],
      [1.7, 400],
      [1.9, 370],
      [2.1, 30],
      [2.3, -400],
    ]),
    "position.1": continuous([
      [1.05, 304],
      [1.3, 350],
      [1.7, 430],
      [2.1, 552],
      [2.3, 600],
    ]),
    "rotation.2": [
      [1.05, -6],
      [1.7, 0],
      [2.3, 12],
    ],
  });
  b.supporting.push(travel);
  const shade = during(b.tint(b.add(c, travel), P.blue), 1.05, 2.3);
  shade.timeOffset = 1.05;
  const lit = during(b.add(c, travel), 1.05, 2.3);
  lit.timeOffset = 1.05;
  // The foreground riders intersect a nearer section of the same spotlight.
  // Intersecting two half-planes keeps the texture fixed while its lighting changes.
  for (const [name, x, slope, left] of [
    ["Near light · left edge", 205, -0.18, true],
    ["Near light · right edge", 870, 0.18, false],
  ]) {
    const direction = [left ? -1 : 1, ((left ? 1 : -1) * slope * 848) / 1280];
    const length = Math.hypot(...direction);
    const [nx, ny] = direction.map((v) => v / length);
    const completion = 100 * (0.5 + ((x - slope * 500) / 1280 - 0.5) * nx - 0.5 * ny);
    lit.effects.push(
      effect(
        "linear-wipe",
        { completion, angle: (Math.atan2(ny, nx) * 180) / Math.PI, feather: 1 },
        name,
      ),
    );
  }
}

export function shaftReunion(b) {
  const c = b.scene("40–41 · Through the light and reunited", 90.9, 95.6, P.blue);
  const dark = rect("The shaft fades into darkness", 640, 424, 1280, 848, P.black);
  animate(dark, "opacity", [
    [0, 0, [0.2814, 0.0013, 0.5072, 0.7341]],
    [2.7, 100],
  ]);
  c.layers.push(dark);
  openingBeam(c);
  const crown = during(b.add(c, b.props.crown, 640, 446, 128), 0, 3.4);
  keyPose(crown, {
    "position.0": continuous([
      [0, 640],
      [0.5, 635],
      [0.95, 820],
      [1.3, 635],
      [1.5, 570],
      [1.9, 630],
      [2.2, 635],
    ]),
    "position.1": continuous([
      [0, 446],
      [0.5, 446],
      [0.95, 480],
      [1.25, 685],
      [1.5, 650],
      [1.7, 535],
      [1.9, 300],
      [2.2, 175],
      [2.3, -50],
      [2.5, 40],
      [2.7, 280],
      [2.9, 240],
      [3.1, 220],
      [3.4, 440],
    ]),
    "rotation.2": [
      [0, 0],
      [0.5, 0],
      [0.9, 90],
      [1.3, 245],
      [1.5, 340],
      [1.7, 380],
      [1.9, 440],
      [2.1, 490],
      [2.2, 360],
      [2.3, 300],
      [2.5, 270],
      [2.7, 360],
    ],
    "scale.0": [
      [0, 12],
      [0.1, 128],
      [0.2, 20],
      [0.3, 128],
      [0.5, 128],
      [0.7, 2],
      [0.9, 120],
      [1.5, 94],
      [2.2, 66],
      [2.7, 46],
      [3.1, 42],
    ],
    "scale.1": [
      [0, 128],
      [0.5, 128],
      [1.5, 94],
      [2.2, 66],
      [2.7, 46],
      [3.1, 42],
    ],
  });
  for (let i = 0; i < 24; i++) {
    const seed = Math.sin(i * 12.9898 + 1) * 43758.5453;
    const r = seed - Math.floor(seed);
    const dot = during(
      b.circle(c, 640, 430, 4 + r * 8, P.cream, "Crown dust"),
      0.4 + i * 0.018,
      2.2,
    );
    dot.expressions = {
      "position.0": `${610 + r * 60}+${30 + r * 120}*sin((time-0.5)*2.7+${i * 0.14})`,
      "position.1": `${405 + r * 50}+260*sin((time-0.5)*4.1-${i * 0.08})`,
      opacity: "100*min(1,(time-0.4)*4)*min(1,(2.2-time)*4)",
    };
  }
  const fish = b.add(c, b.props.fish, 430, 465, 46, -8);
  during(fish, 0, 0.95);
  animate(fish, "position.0", [
    [0, 800],
    [0.25, 780],
    [0.5, 310],
    [0.7, 380],
    [0.95, -100],
  ]);
  crossingRiders(b, c);
  reunionScene(b, c);
  return c;
}
