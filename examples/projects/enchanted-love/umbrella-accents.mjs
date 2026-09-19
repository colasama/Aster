import {
  animate,
  constant,
  during,
  id,
  joint,
  linear,
  palette as P,
  parent,
  place,
  rect,
  rgba,
} from "./authoring.mjs";
import { keyPose } from "./scenes.mjs";

function crownEchoes(b) {
  const c = b.scene("25 · Echoes in the dark", 61.2, 1891 / 30, P.black);
  const outline = structuredClone(b.props.crown);
  outline.id = id("comp");
  outline.name = "Crown · fine outline echo";
  for (const layer of outline.layers) {
    layer.id = id("layer");
    layer.color = [0, 0, 0, 0];
    layer.shape.strokeColor = rgba(P.teal);
    layer.shape.strokeWidth = 1.5;
    layer.shape.lineJoin = "miter";
  }
  b.supporting.push(outline);
  // Echoes sample one fall, hover, lift, and rebound path with a short delay.
  const motion = {
    "position.1": [
      [0, 320],
      [0.18, 519],
      [0.55, 553],
      [0.85, 493],
      [1.2, 318],
      [1.48, 72],
      [1.61, 52],
      [1.833333333, 183],
    ],
    "rotation.2": [
      [0, -8],
      [0.2, -5],
      [0.5, 80],
      [0.8, 240],
      [1.1, 464],
      [1.4, 628],
      [1.65, 701],
      [1.833333333, 712],
    ],
    "scale.0": [
      [0, 115],
      [0.55, 105],
      [1.12, 66],
      [1.46, 100],
      [1.833333333, 115],
    ],
    "scale.1": [
      [0, 115],
      [0.55, 105],
      [1.12, 78],
      [1.46, 115],
      [1.833333333, 115],
    ],
  };
  for (let echo = 5; echo >= 0; echo--) {
    const node = b.add(c, echo ? outline : b.props.crown, 640, 320, 115);
    if (!echo) b.tint(node, P.teal);
    for (const [property, keys] of Object.entries(motion))
      animate(
        node,
        property,
        keys.map(([t, value]) => [t + echo * 0.018, value]),
      );
  }
}

function liftedGirl(b) {
  const c = b.scene("26a · Lifted by the umbrella", 1891 / 30, 1912 / 30);
  const girl = b.characters.girls.umbrellaLift;
  const part = (name) => girl.layers.find((l) => l.name === name);
  const torso = part("Torso");
  const dress = girl.layers.find((l) => l.kind === "precomposition" && l.name === "Girl · tunic");
  if (dress) dress.transform.scale[0] = constant(80);
  const shoulder = part("L arm · upper");
  const elbow = part("L arm · lower");
  const extension =
    "(clamp((time-0.07)/0.1,0,1)*(1-clamp((time-0.29)/0.14,0,1))+clamp((time-0.58)/0.11,0,1))";
  const fold = "(clamp((time-0.3)/0.13,0,1)*(1-clamp((time-0.55)/0.07,0,1)))";
  const upper = `(20+150*${extension})`;
  const lower = `(160-160*${extension})`;
  shoulder.expressions = { "rotation.2": upper, "position.1": `-163+30*${fold}` };
  part("R arm · upper").expressions = { "position.1": `-163+30*${fold}` };
  part("Head pivot").expressions["position.1"] = `-151+16*${fold}`;
  dress.expressions = { "scale.1": `88-14*${fold}`, "position.1": `-65+12*${fold}` };
  elbow.expressions = { "rotation.2": lower };
  // Keep the gripping hand fixed to the handle while the elbow unfolds.
  torso.expressions = {
    "position.0": `183+56*sin(${upper}*pi/180)+49*sin((${upper}+${lower})*pi/180)`,
    "position.1": `163-30*${fold}-56*cos(${upper}*pi/180)-49*cos((${upper}+${lower})*pi/180)`,
  };
  animate(part("R arm · upper"), "rotation.2", [
    [0, -91],
    [0.067, -91],
    [0.2, -12],
    [0.3, -12],
    [0.467, -61],
    [0.6, -94],
    [0.7, -130],
  ]);
  animate(part("R arm · lower"), "rotation.2", -7);
  for (const [side, sign] of [
    ["L", 1],
    ["R", -1],
  ]) {
    const calf = part(`${side} leg · lower`);
    calf.expressions = { "rotation.2": `${sign}*(88-40*${extension})` };
    const foot = parent(rect(`${side} outward foot`, 0, 40, 28, 39, P.cream, 14), calf);
    foot.expressions = { "rotation.2": `${-sign}*(88-40*${extension})` };
    girl.layers.push(foot);
  }
  const beam = rect("Umbrella's vertical shadow", 640, 477, 122, 474, P.teal);
  c.layers.push(beam);
  animate(beam, "scale.1", [
    [0, 100],
    [0.167, 100],
    [0.3, 100],
    [0.467, 103],
    [0.667, 100],
  ]);
  const assembly = joint("Umbrella handle · two buoyant beats", 617, 380);
  c.layers.push(assembly);
  animate(assembly, "position.1", [
    [0, 402],
    [0.066666667, 382],
    [0.25, 421],
    [0.4, 282],
    [0.53, 292],
    [0.6, 299],
    [0.633333333, 313],
    [0.7, 420],
  ]);
  parent(b.add(c, b.props.umbrella, 0, -138, 95), assembly);
  const canopy = b.props.umbrella.layers.find((l) => l.name === "Canopy");
  // A separate umbrella variant keeps the shared walking and parade props intact.
  const shallow = structuredClone(b.props.umbrella);
  shallow.id = id("comp");
  shallow.name = "Umbrella · shallow frontal canopy";
  for (const l of shallow.layers) {
    l.id = id("layer");
    if (l.name === canopy.name) l.transform.scale[1] = constant(77);
    if (l.name === "Shaft") l.shape.path.vertices[0].position[1] = 0.38;
  }
  b.supporting.push(shallow);
  c.layers.at(-1).sourceCompositionId = shallow.id;
  parent(b.add(c, girl, 43, 380), assembly);
  return c;
}

function foldingFrog(b) {
  const c = b.scene("26b · Frog on a curling colour card", 1912 / 30, 1947 / 30);
  const hinge = joint("Card hinge", 620, 540, -2);
  c.layers.push(hinge);
  keyPose(hinge, {
    "position.0": [
      [0, 620],
      [0.267, 544],
      [0.533333333, 613],
      [0.8, 990],
      [1.1, 862],
      [1.166666667, 858],
    ],
    "position.1": [
      [0, 524],
      [0.267, 578],
      [0.6, 150],
      [0.8, 538],
      [1.1, 545],
    ],
    "rotation.2": [
      [0, -2],
      [0.267, 25],
      [0.533333333, 350],
      [0.8, 376],
      [1.1, 360],
    ],
  });
  const card = b.morph(
    c,
    "Rectangle curling into a quarter disc",
    [
      [-82, -210],
      [82, -210],
      [82, 12],
      [-82, 12],
    ],
    [
      [-82, -210],
      [82, -210, [0, 0], [0, 170]],
      [-224, 40, [169, 0]],
      [-82, 12],
    ],
    0,
    0.167,
    P.blue,
  );
  parent(card, hinge);
  during(card, 0, 0.333333333);
  const rider = structuredClone(b.characters.seatedFrog);
  rider.id = id("comp");
  rider.name = "Frog · seated on the curling card";
  const green = rgba(P.green);
  rider.layers = rider.layers.filter((l) => l.name !== "Folded foot");
  for (const layer of rider.layers) {
    layer.id = id("layer");
    if (layer.color.every((v, i) => v === green[i])) layer.color = rgba(P.turquoise);
  }
  b.supporting.push(rider);
  const frog = parent(b.add(c, rider, -14, -110, 77, -4), hinge);
  animate(frog, "scale.0", 65);
  animate(frog, "position.1", [
    [0, -108],
    [0.167, -147],
    [0.3, -205],
  ]);
  during(frog, 0, 0.333333333);
  const square = parent(rect("Folded card", 0, -6, 170, 170, P.blue), hinge);
  c.layers.push(during(square, 0.333333333, 0.633333333));
  const crown = parent(b.tint(b.add(c, b.props.crown, 0, 0, 122), P.blue), hinge);
  during(crown, 0.633333333, c.duration);
  return c;
}

function threeHearts(b) {
  const c = b.scene("26c · Folded crown opens into three hearts", 1947 / 30, 1969 / 30);
  const extended = [
    [-55, -66],
    [-28, -93],
    [0, -66],
    [28, -93],
    [55, -66],
    [55, 50],
    [0, 105],
    [-55, 50],
  ];
  const settled = [
    [-55, -7],
    [-28, -34],
    [0, -7],
    [28, -34],
    [55, -7],
    [55, -7],
    [0, 49],
    [-55, -7],
  ];
  for (let i = 0; i < 3; i++) {
    const t = (2 - i) * 0.1 + 0.066666667;
    const x = 437 + i * 202;
    for (const [start, fill] of [
      [t, P.cream],
      [0.333333333 + i * 0.066666667, P.teal],
    ]) {
      const heart = b.morph(
        c,
        "Heart unfolds and settles",
        extended,
        settled,
        start,
        start + 0.1,
        fill,
      );
      during(heart, start, c.duration);
      place(heart, x, 550);
      animate(heart, "position.1", [
        [start, 550],
        [start + 0.1, 519],
      ]);
    }
    const landing = rect("Heart beat underline", x, 551, 220, 3, P.teal);
    c.layers.push(during(landing, t, c.duration));
    animate(landing, "position.1", [
      [t, 551],
      [t + 0.133333333, 632],
    ]);
    animate(
      landing,
      "scale.0",
      [
        [t, 100],
        [t + 0.133333333, 40],
        [0.733333333, 10],
      ],
      linear,
    );
  }
  const folded = rect("Final compressed crown", 858, 545, 110, 110, P.blue);
  c.layers.push(during(folded, 0, 0.066666667));
}

export function umbrellaAccents(b) {
  crownEchoes(b);
  liftedGirl(b);
  foldingFrog(b);
  threeHearts(b);
}
