import {
  animate,
  comp,
  constant,
  continuous,
  during,
  ellipse,
  joint,
  line,
  palette as P,
  parent,
  place,
  rect,
  rgba,
  track,
  vector,
} from "./authoring.mjs";

// A circle with one radial notch. Four cubic arcs preserve the circular rim.
function lilyPad() {
  const radius = 100;
  const angles = [-72, 9, 90, 171, 252].map((v) => (v * Math.PI) / 180);
  const k = (4 / 3) * Math.tan((angles[1] - angles[0]) / 4);
  const vertices = angles.map((angle, i) => [
    radius * Math.cos(angle),
    radius * Math.sin(angle),
    i ? [radius * Math.sin(angle) * k, -radius * Math.cos(angle) * k] : [0, 0],
    i < 4 ? [-radius * Math.sin(angle) * k, radius * Math.cos(angle) * k] : [0, 0],
  ]);
  vertices.push([0, -45]);
  const c = comp("Water · circular lily with a single notch", 200, 200);
  c.layers.push(place(vector("Notched circular leaf", vertices, P.green), 100, 100));
  return c;
}

function cameraCurve(node, property, points) {
  animate(node, property, continuous(points));
}

export function waterPassage(b) {
  const c = b.scene("19 · Water fan, flowing stream, and circular ripples", 50.6, 53, P.blue);
  const lily = lilyPad();
  b.supporting.push(lily);

  const stream = comp(
    "Water · one oscillating flow line repeated across the stream",
    1280,
    848,
    c.duration,
  );
  const wave = (sign) => [
    [0, -420, [0, 0], [sign * 70, 180]],
    [0, 80, [sign * 70, -180], [-sign * 70, 180]],
    [0, 580, [-sign * 70, -180], [sign * 70, 180]],
    [0, 1080, [sign * 70, -180]],
  ];
  const flow = place(line("S-shaped flow line", wave(1), P.teal, 6), 640, 0);
  flow.shape.morph = {
    target: line("Opposite wave phase", wave(-1), P.teal, 6).shape.path,
    progress: constant(0),
  };
  flow.cloner = {
    distribution: { kind: "grid", count: [23, 1, 1], spacing: [70, 0, 0] },
    effectors: [],
  };
  flow.expressions = {
    "shape.morphProgress": "50-50*cos((time-0.4)*3.8)",
    "position.0": "640+22*sin((time-0.4)*3)",
  };
  stream.layers.push(flow);
  b.supporting.push(stream);
  const flowing = during(b.add(c, stream), 11 / 30, c.duration);
  flowing.timeOffset = 11 / 30;

  const drift = joint("Stream current", 0, 0);
  cameraCurve(drift, "position.0", [
    [0.4, 0],
    [1.2, 0],
    [1.3, 60],
    [1.4, 270],
    [1.5, 500],
    [1.7, 670],
    [2.1, 750],
    [2.2, 730],
    [2.3, 650],
    [2.4, 330],
  ]);
  c.layers.push(drift);
  const streamLeaves = [];
  for (const [xs, ys, size, spin] of [
    [
      [
        [0.4, 570],
        [0.7, 522],
        [1.1, 458],
        [1.7, 469],
      ],
      [
        [0.4, 176],
        [1.3, 115],
        [1.7, 170],
        [2.4, 105],
      ],
      100,
      0,
    ],
    [
      [
        [0.4, 319],
        [0.8, 274],
        [1.2, 374],
        [1.7, 348],
      ],
      [
        [0.4, 688],
        [1, 648],
        [1.3, 684],
        [1.7, 760],
        [2.4, 600],
      ],
      171,
      180,
    ],
    [
      [
        [0.4, 967],
        [0.7, 833],
        [1, 734],
        [1.7, 880],
      ],
      [
        [0.4, 475],
        [1.3, 462],
        [1.7, 500],
        [2.4, 450],
      ],
      68,
      145,
    ],
  ]) {
    const leaf = parent(b.add(c, lily, 0, 0, size), drift);
    during(leaf, 11 / 30, c.duration);
    cameraCurve(leaf, "position.0", xs);
    cameraCurve(leaf, "position.1", ys);
    const rotations =
      spin === 0
        ? [
            [0.4, 0],
            [0.6, 95],
            [1.1, 176],
            [1.3, 207],
            [1.5, 345],
            [1.7, 400],
            [2.1, 415],
            [2.4, 470],
          ]
        : spin === 180
          ? [
              [0.4, 180],
              [0.6, 260],
              [1.1, 340],
              [1.3, 395],
              [1.5, 550],
              [1.7, 565],
              [2.1, 605],
              [2.4, 595],
            ]
          : [
              [0.4, 145],
              [0.6, 280],
              [1.1, 385],
              [1.3, 430],
              [1.5, 520],
            ];
    cameraCurve(leaf, "rotation.2", rotations);
    streamLeaves.push(c.layers.pop());
  }

  // The second patch, its ripples, and five leaves travel in one water coordinate system.
  const radial = joint("Circular water patch · shared current", 0, 0);
  cameraCurve(radial, "position.0", [
    [1.3, -1320],
    [1.4, -580],
    [1.5, -190],
    [1.7, 0],
    [2.1, 100],
    [2.2, 80],
    [2.3, 0],
    [2.4, -320],
  ]);
  c.layers.push(radial);
  const patch = parent(
    place(
      vector(
        "Curved edge of the incoming water",
        [
          [-2400, -500],
          [1190, -500, [0, 0], [-55, 440]],
          [1190, 1300, [-55, -440]],
          [-2400, 1300],
        ],
        P.teal,
      ),
      0,
      0,
    ),
    radial,
  );
  delete patch.parentId;
  cameraCurve(patch, "position.0", [
    [1.3, -1320],
    [1.4, -580],
    [1.5, -190],
    [1.7, 0],
    [2.1, 125],
    [2.3, 360],
    [2.4, 800],
  ]);
  c.layers.push(during(patch, 1.3, c.duration));
  for (const radius of [650, 945]) {
    const ring = parent(
      ellipse("Circular flow contour", -245, 780, radius * 2, radius * 2, P.teal),
      radial,
    );
    ring.color = [0, 0, 0, 0];
    ring.shape.strokeColor = rgba("#10b095");
    ring.shape.strokeWidth = 2.5;
    ring.expressions = { "scale.0": "100+12*(time-1.7)", "scale.1": "100+12*(time-1.7)" };
    c.layers.push(during(ring, 1.3, c.duration));
  }
  for (const [x, y, size, phase, spin] of [
    [110, 85, 135, 0, 155],
    [290, 286, 69, 1, -90],
    [70, 721, 113, 2, 25],
  ]) {
    const leaf = parent(b.add(c, lily, x, y, size), radial);
    during(leaf, 1.3, c.duration);
    leaf.expressions = {
      "position.1": `${y}-105*max(0,time-1.7)+8*sin((time-1.7)*4+${phase})`,
      "rotation.2": `${spin}+75*sin((time-1.7)*3+${phase})+120*(time-1.7)`,
      "scale.0": `${size}*(1+0.03*sin(time*8+${phase}))`,
      "scale.1": `${size}*(1-0.025*sin(time*8+${phase}))`,
    };
  }
  c.layers.push(...streamLeaves);
  const tadpole = parent(
    place(
      vector(
        "Tadpole · rounded head and curved tail",
        [
          [-170, 0, [0, 0], [80, -15]],
          [24, -25, [-55, 10], [40, -8]],
          [49, 9, [13, -17], [-9, 25]],
          [13, 27, [22, 0], [-67, -13]],
        ],
        P.blue,
      ),
      580,
      731,
    ),
    radial,
  );
  tadpole.shape.morph = {
    target: vector(
      "Curled swimming tail",
      [
        [-170, 0, [0, 0], [80, 20]],
        [24, -55, [-25, 63], [28, -20]],
        [61, -34, [4, -25], [-18, 65]],
        [13, 17, [31, -4], [-63, 27]],
      ],
      P.blue,
    ).shape.path,
    progress: constant(0),
  };
  tadpole.expressions = {
    "shape.morphProgress": "50+50*sin((time-1.7)*5-1.57)",
    "position.0": "580+350*(time-1.7)",
    "position.1": "731-420*pow(max(0,time-2.05),2)",
    "rotation.2": "-10-160*pow(max(0,time-2.05),2)",
  };
  c.layers.push(during(tadpole, 1.3, c.duration));

  const crown = during(b.add(c, b.props.crown, 760, 550, 109), 11 / 30, 71 / 30);
  cameraCurve(crown, "position.0", [
    [0.366666667, 735],
    [0.9, 928],
    [1.2, 909],
    [1.4, 771],
    [1.7, 555],
    [2.1, 495],
    [2.366666667, 475],
  ]);
  cameraCurve(crown, "position.1", [
    [0.366666667, 540],
    [0.8, 601],
    [1.2, 545],
    [1.4, 496],
    [1.7, 425],
    [2.1, 416],
    [2.366666667, 430],
  ]);
  cameraCurve(crown, "rotation.2", [
    [0.366666667, -150],
    [0.4, -129],
    [0.6, -90],
    [0.8, -45],
    [1.1, -6],
    [1.4, 87],
    [1.7, 219],
    [2.1, 307],
    [2.366666667, 320],
  ]);

  const bar = during(
    rect("Crown stretches into the next cut", 210, 265, 480, 160, P.cream),
    71 / 30,
    c.duration,
  );
  bar.transform.rotation[2] = constant(28);
  c.layers.push(bar);

  // A closing quarter-disc becomes the cream baton that introduces the water.
  const cover = rect("Opening turquoise field", 640, 424, 1280, 848, P.turquoise);
  c.layers.push(during(cover, 0, 8 / 30));
  const bank = joint("Opening diagonal wipe", 640, 0, -31.5);
  c.layers.push(bank);
  cameraCurve(bank, "rotation.2", [
    [8 / 30, -57.7],
    [0.3, -31.5],
    [11 / 30, 10],
  ]);
  cameraCurve(bank, "position.1", [
    [8 / 30, -420],
    [0.3, 365],
    [11 / 30, 1220],
  ]);
  c.layers.push(
    during(
      parent(rect("Wipe foreground", 0, 1200, 4000, 2400, P.turquoise), bank),
      8 / 30,
      11 / 30,
    ),
  );
  for (const [start, end, color] of [
    [0, 1 / 30, P.green],
    [1 / 30, 2 / 30, P.teal],
    [2 / 30, 3 / 30, P.green],
    [3 / 30, 9 / 30, P.cream],
  ]) {
    const fan = place(
      vector(
        "Closing fan · one quarter-circle",
        [
          [0, 0],
          [0, -455, [0, 0], [251, 0]],
          [455, 0, [0, -251]],
        ],
        color,
      ),
      365,
      741,
      100,
      8.5,
    );
    fan.shape.morph = {
      target: vector(
        "Closed fan",
        [
          [0, 0],
          [0, -455, [0, 0], [48, 0]],
          [141, -433, [-46, -14]],
        ],
        color,
      ).shape.path,
      progress: track([
        [0.1, 0, [0.2, 0.8, 0.3, 1]],
        [5 / 30, 100],
      ]),
    };
    c.layers.push(during(fan, start, end));
  }
  const baton = during(rect("Rotating cream baton", 580, 438, 245, 84, P.cream), 9 / 30, 11 / 30);
  cameraCurve(baton, "rotation.2", [
    [8 / 30, 90],
    [0.3, 36],
    [11 / 30, 30],
  ]);
  cameraCurve(baton, "position.0", [
    [8 / 30, 450],
    [11 / 30, 730],
  ]);
  c.layers.push(baton);
  return c;
}
