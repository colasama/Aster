import {
  comp,
  constant,
  ellipse,
  instance,
  joint,
  line,
  palette as P,
  parent,
  place,
  rect,
  track,
  vector,
} from "./authoring.mjs";

export function createProps() {
  const assets = [];
  const add = (name, w, h, layers) => {
    const c = comp(name, w, h);
    c.layers = layers;
    assets.push(c);
    return c;
  };
  const crown = add("Crown · seven anchors", 140, 76, [
    place(
      vector(
        "Crown",
        [
          [-70, 38],
          [70, 38],
          [70, -38],
          [30, -7],
          [0, -38],
          [-30, -7],
          [-70, -38],
        ],
        P.cream,
      ),
      70,
      38,
    ),
  ]);
  const heart = add("Heart · geometric", 140, 100, [
    place(
      vector(
        "Heart",
        [
          [-70, -10],
          [-35, -45],
          [0, -10],
          [35, -45],
          [70, -10],
          [0, 60],
        ],
        P.cream,
      ),
      70,
      45,
    ),
  ]);
  const snail = add("Snail · body and spiral shell", 180, 140, [
    place(
      vector(
        "Soft body",
        [
          [0, -40, [0, 0], [0, -12]],
          [40, -42, [-10, -12], [0, 38]],
          [94, 31, [-38, -7], [24, 0]],
          [127, 44, [0, -12], [0, 9]],
          [28, 50, [36, 0], [-25, 0]],
          [0, -40, [5, 39]],
        ],
        P.cream,
      ),
      21,
      77,
    ),
    ellipse("Left eye", 20, 35, 35, 35, P.cream),
    ellipse("Right eye", 69, 34, 35, 35, P.cream),
    rect("Left pupil", 20, 36, 19, 6, P.teal, 3),
    rect("Right pupil", 69, 35, 19, 6, P.teal, 3),
    line(
      "Shell spiral",
      [
        [85, 59, [0, 0], [3, -44]],
        [145, 31, [-34, -12], [34, 14]],
        [152, 92, [32, -17], [-23, 15]],
        [105, 72, [-10, 22], [4, -18]],
        [125, 63, [-14, -10]],
      ],
      P.cream,
      9,
    ),
  ]);
  const stair = add("Stairs · three-step module", 330, 180, [
    line(
      "Three risers",
      [
        [0, 0],
        [100, 0],
        [100, 45],
        [200, 45],
        [200, 90],
        [300, 90],
        [300, 135],
        [315, 135],
      ],
      P.cream,
      3,
    ),
  ]);
  const window = add("Window · paired panes", 300, 300, [
    rect("Left pane", 73, 150, 140, 300, P.cream),
    rect("Right pane", 227, 150, 140, 300, P.cream),
  ]);
  const ring = add("Swim ring · eight sectors", 240, 240, []);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4,
      b = ((i + 1) * Math.PI) / 4,
      k = (4 / 3) * Math.tan((b - a) / 4);
    const polar = (r, t) => [Math.cos(t) * r, Math.sin(t) * r];
    const tangent = (r, t, f) => [-Math.sin(t) * r * f, Math.cos(t) * r * f];
    ring.layers.push(
      place(
        vector(
          `Sector ${i + 1}`,
          [
            [...polar(120, a), [0, 0], tangent(120, a, k)],
            [...polar(120, b), tangent(120, b, -k)],
            [...polar(56, b), [0, 0], tangent(56, b, -k)],
            [...polar(56, a), tangent(56, a, k)],
          ],
          i % 2 ? P.cream : P.blue,
        ),
        120,
        120,
      ),
    );
  }
  const ball = add("Beach ball · four curved panels", 150, 150, [
    ellipse("Sphere", 75, 75, 150, 150, P.blue),
  ]);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2,
      b = a + Math.PI / 4,
      k = (4 / 3) * Math.tan(Math.PI / 16);
    const start = [75 * Math.cos(a), 75 * Math.sin(a)];
    const end = [75 * Math.cos(b), 75 * Math.sin(b)];
    const panel = (pole) => [
      [...pole, [0, 0], [(start[0] - pole[0]) * 0.7, (start[1] - pole[1]) * 0.4]],
      [
        ...start,
        [-start[0] * 0.12, -start[1] * 0.12],
        [-75 * Math.sin(a) * k, 75 * Math.cos(a) * k],
      ],
      [
        ...end,
        [75 * Math.sin(b) * k, -75 * Math.cos(b) * k],
        [(pole[0] - end[0]) * 0.3, (pole[1] - end[1]) * 0.7],
      ],
    ];
    const paint = place(vector(`Ivory panel ${i + 1}`, panel([-16, -26]), P.cream), 75, 75);
    paint.shape.morph = {
      target: vector("Side-facing panel", panel([-70, 0]), P.cream).shape.path,
      progress: constant(0),
    };
    paint.expressions = { "shape.morphProgress": "50-50*cos(time*1.309)" };
    ball.layers.push(paint);
  }
  const pole = ellipse("Air valve", 59, 49, 13, 13, P.teal);
  pole.expressions = {
    "position.0": "59-27*(1-cos(time*1.309))",
    "position.1": "49+13*(1-cos(time*1.309))",
  };
  ball.layers.push(pole);
  const stripedBall = add("Beach ball · side view", 150, 150, [
    ellipse("Blue sphere", 75, 75, 150, 150, P.blue),
    place(ellipse("Equatorial band", 75, 75, 150, 48, P.cream), 75, 75, 100, 18),
    place(
      vector(
        "Upper ivory panel",
        [
          [-73, -16, [0, 0], [5, -48]],
          [58, -47, [-32, -40], [-65, -12]],
          [-73, -16, [48, -34]],
        ],
        P.cream,
      ),
      75,
      75,
    ),
    ellipse("Air valve", 2, 70, 5, 9, P.teal),
  ]);
  const umbrella = add("Umbrella · canopy and handle", 320, 320, [
    place(
      vector(
        "Canopy",
        [
          [-155, 0, [0, 0], [0, -86]],
          [0, -155, [-86, 0], [86, 0]],
          [155, 0, [0, -86], [0, 0]],
        ],
        P.blue,
      ),
      160,
      168,
    ),
    line(
      "Shaft",
      [
        [160, 10],
        [160, 295],
      ],
      P.blue,
      7,
    ),
    line(
      "Handle",
      [
        [160, 285, [0, 0], [0, 26]],
        [182, 309, [-18, 0], [18, 0]],
        [200, 289, [0, 14]],
      ],
      P.blue,
      10,
    ),
  ]);
  const paradeUmbrella = tiltedUmbrella(P.teal);
  const heldUmbrella = tiltedUmbrella(P.turquoise);
  assets.push(paradeUmbrella, heldUmbrella);
  const fish = add("Fish · ribbon silhouette", 380, 100, [
    place(
      vector(
        "Tail ribbon",
        [
          [-170, 0, [0, 0], [60, -12]],
          [82, -8, [-70, -18], [0, 0]],
          [82, 8, [0, 0], [-90, 15]],
          [-170, 0, [60, 10]],
        ],
        P.cream,
      ),
      190,
      50,
    ),
    place(
      vector(
        "Fish body",
        [
          [-40, 0, [0, 0], [12, -9]],
          [35, -32, [-30, -4], [28, 1]],
          [50, 27, [28, -5], [-26, 14]],
          [-40, 0, [10, 8]],
        ],
        P.blue,
      ),
      285,
      50,
    ),
    ellipse("Eye", 315, 42, 10, 11, P.cream),
    ellipse("Pupil", 317, 42, 4, 5, P.blue),
  ]);
  const sparkle = add("Sparkle · four rays", 60, 60, [
    rect("Upper ray", 30, 11.5, 5, 22, P.cream, 2.5),
    rect("Lower ray", 30, 48.5, 5, 22, P.cream, 2.5),
    rect("Left ray", 11.5, 30, 22, 5, P.cream, 2.5),
    rect("Right ray", 48.5, 30, 22, 5, P.cream, 2.5),
  ]);
  const note = add("Music note", 70, 140, [
    ellipse("Note head", 27, 115, 40, 27, P.blue),
    rect("Stem", 46, 65, 7, 113, P.blue, 3),
  ]);
  const lily = add("Lily pad · three curve anchors", 200, 200, [
    place(
      vector(
        "Notched disc",
        [
          [-23, -92, [-100, 0], [0, 0]],
          [0, -57],
          [23, -92, [0, 0], [125, 20]],
          [0, 100, [130, 0], [-133, 0]],
        ],
        P.green,
      ),
      100,
      100,
    ),
  ]);
  const crab = add("Crab · body and claws", 240, 130, [
    ellipse("Body", 120, 92, 122, 46, P.blue),
    line(
      "Eye stalks",
      [
        [78, 64],
        [83, 32],
        [88, 64],
      ],
      P.blue,
      8,
    ),
    line(
      "Eye stalks",
      [
        [157, 64],
        [161, 29],
        [166, 62],
      ],
      P.blue,
      8,
    ),
    ellipse("Left eye", 83, 30, 30, 27, P.cream),
    ellipse("Right eye", 161, 27, 29, 26, P.cream),
    line(
      "Pupil",
      [
        [74, 28],
        [90, 29],
      ],
      P.blue,
      6,
    ),
    line(
      "Pupil",
      [
        [153, 25],
        [169, 26],
      ],
      P.blue,
      6,
    ),
    place(
      vector(
        "Left claw",
        [
          [0, 0, [-29, 26], [-45, -6]],
          [-40, -38],
          [-13, -16],
          [-26, -63, [0, 0], [44, -10]],
          [3, -13],
        ],
        P.blue,
      ),
      46,
      96,
    ),
    place(
      vector(
        "Right claw",
        [
          [0, 0, [29, 26], [45, -6]],
          [40, -38],
          [13, -16],
          [26, -63, [0, 0], [-44, -10]],
          [-3, -13],
        ],
        P.blue,
      ),
      194,
      96,
    ),
  ]);
  for (const x of [65, 93, 148, 177])
    crab.layers.push(
      line(
        "Leg",
        [
          [x, 96],
          [x - 12, 116],
          [x + 4, 120],
        ],
        P.blue,
        4,
      ),
    );
  return {
    assets,
    crown,
    heart,
    snail,
    stair,
    window,
    ring,
    ball,
    stripedBall,
    umbrella,
    paradeUmbrella,
    heldUmbrella,
    fish,
    sparkle,
    note,
    lily,
    crab,
  };
}

// One six-anchor canopy moves from a top view, through profile, to its underside.
// Instances freeze this two-second pose strip with time remapping.
function tiltedUmbrella(fill) {
  const c = comp(`Umbrella · pitch poses · ${fill}`, 320, 340, 2.033333333);
  const handle = joint("Foreshortened handle", 160, 170);
  handle.expressions = { "scale.1": "100*sin(time*pi/2)" };
  c.layers.push(
    handle,
    parent(
      line(
        "Shaft",
        [
          [0, 0],
          [0, 123],
        ],
        P.blue,
        5,
      ),
      handle,
    ),
    parent(
      line(
        "Crook",
        [
          [0, 119, [0, 0], [0, 28]],
          [17, 141, [-16, 0], [17, 0]],
          [32, 120, [0, 16]],
        ],
        P.blue,
        9,
      ),
      handle,
    ),
    rect("Finial", 160, 38, 5, 12, fill, 2),
  );
  const top = [
    [-150, 0],
    [-88, -120],
    [88, -120],
    [150, 0],
    [88, 120],
    [-88, 120],
  ];
  const side = [
    [-150, 0, [0, 0], [15, -65]],
    [-62, -111, [-51, 13], [39, -12]],
    [62, -111, [-39, -12], [51, 13]],
    [150, 0, [-15, -65]],
    [88, 6],
    [-88, 6],
  ];
  for (const [start, end, from, to] of [
    [0, 1, top, side],
    [1, c.duration, side, top],
  ]) {
    const canopy = place(vector("Canopy pitch", from, fill), 160, 170);
    canopy.inPoint = start;
    canopy.outPoint = end;
    canopy.shape.morph = {
      target: vector("Canopy target", to, fill).shape.path,
      progress: track([
        [start, 0],
        [end, 100],
      ]),
    };
    c.layers.push(canopy);
  }
  const underside = place(
    vector(
      "Shaded underside",
      [
        [-150, 0],
        [-88, -24],
        [88, -24],
        [150, 0],
        [88, 96],
        [-88, 96],
      ],
      P.blue,
    ),
    160,
    170,
  );
  underside.inPoint = 1;
  underside.outPoint = c.duration;
  underside.transform.scale[1] = track([
    [1, 0],
    [2, 100],
  ]);
  c.layers.push(underside);
  return c;
}

export function prop(source, x, y, scale = 100, angle = 0, name) {
  return place(instance(source, name), x, y, scale, angle);
}
