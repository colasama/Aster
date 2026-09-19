import {
  animate,
  comp,
  constant,
  during,
  effect,
  ellipse,
  id,
  joint,
  linear,
  palette as P,
  parent,
  place,
  rect,
  track,
  vector,
} from "./authoring.mjs";

export function ledgeScene(b) {
  const { scene, add, characters: a, props: p } = b;
  const c = scene("35 · Recover and start running", 79.6, 81.733333333);
  const angle = "-15.4+4.1*time";
  const intercept = "787-48*time-5.85*time*time";
  const pan = "380*pow(max(0,time-0.6),2)+800*pow(max(0,time-1.3),2)";
  const camera = joint("Bank camera · settle and follow", 0, 787);
  camera.expressions = {
    "position.0": pan,
    "position.1": `(${intercept})+tan((${angle})*pi/180)*(${pan})`,
    "rotation.2": angle,
  };
  c.layers.push(camera);
  const girl = parent(during(add(c, a.girls.recover, 760, 0, 90), 0, 1.7), camera);
  animate(girl, "anchor.1", [
    [0, 549],
    [0.4, 639],
  ]);
  for (const [source, x, radius, scale, speed, offset] of [
    [p.ring, 38, 150, 125, 480, 40],
    [p.stripedBall, 282, 80, 105, 520, 12],
    [p.crown, 542, 86, 115, 560, 15],
  ]) {
    const rolling = parent(add(c, source, x, -radius, scale), camera);
    const travel = `${speed}*time+450*pow(max(0,time-0.6),2)`;
    rolling.expressions = {
      "position.0": `${x}-(${travel})`,
      "rotation.2": `${offset}+(${travel})/${radius}*57.2957795`,
    };
  }
  c.layers.push(parent(rect("Foreground bank", 0, 2000, 10000, 4000, P.teal), camera));

  const runner = during(add(c, a.girls.run, 1400, 520), 1.7, c.duration);
  runner.timeOffset = 0.233333333;
  runner.transform.anchor[1] = constant(650);
  const returnX = "1400-738.461538*(time-1.7)";
  runner.expressions = {
    "position.0": returnX,
    "position.1": `(${intercept})+tan((${angle})*pi/180)*(${returnX})-16`,
  };
  for (const [axis, sign] of [
    ["scale.0", -1],
    ["scale.1", 1],
  ])
    animate(runner, axis, [
      [1.7, sign * 96],
      [c.duration, sign * 76.5],
    ]);
  return c;
}

export function divingScene(b) {
  const { scene, add, circle, supporting, characters: a, props: p } = b;
  const c = scene("36 · The dive", 81.733333333, 86.2, P.turquoise);
  const depth = rect("Water colour settles with depth", 640, 424, 1280, 848, P.teal);
  animate(depth, "opacity", [
    [3.2, 0],
    [3.8, 60],
    [4.1, 100],
  ]);
  c.layers.push(depth);
  const world = comp("Dive · runner, ledge, and destination", 1280, 848, c.duration);
  circle(world, 0, 0, 800, P.green, "Circular destination");

  // The tapered ledge retracts while the camera pulls back from the running girl.
  const ledgePath = (upper, lower) => [
    [0, 0, [0, 0], [1333.333, 0]],
    [4000, upper, [-1333.333, (-upper * 2) / 3]],
    [4000, lower + 14, [0, 0], [-1333.333, (-lower * 2) / 3]],
    [0, 14, [1333.333, 0]],
  ];
  const ledge = place(
    b.morph(
      world,
      "Curved ledge",
      ledgePath(-332.8, 1600),
      ledgePath(-416, 4800),
      0,
      2.766666667,
      P.teal,
    ),
    0,
    -12,
  );
  ledge.shape.morph.progress = track(
    [
      [0, 0],
      [2.766666667, 100],
    ],
    linear,
  );
  const tip = "min(430,-1400+1000*time-125*time*time)";
  const ledgeY =
    "-12+13*sin(pi*min(time,2.766666667)/2.766666667)+26*min(1,max(0,(time-2.766666667)/0.5))";
  const curvature = "0.0000208+0.0000052*min(1,time/2.766666667)";
  ledge.expressions = { "position.0": tip, "position.1": ledgeY };

  const u = "min(1,max(0,time/2.833333333))";
  const travel = `3*(${u})*pow(1-(${u}),2)*0.737+3*pow(${u},2)*(1-(${u}))*0.857+pow(${u},3)`;
  const runnerX = `1694-1244*(${travel})`;
  const runner = during(add(world, a.girls.run, 0, 0, 42.5), 0, 2.833333333);
  runner.transform.anchor[1] = constant(650);
  for (const [axis, sign] of [
    ["scale.0", -1],
    ["scale.1", 1],
  ])
    animate(runner, axis, [
      [0, sign * 45],
      [0.8, sign * 42.5],
      [1.266666667, sign * 42.5],
      [2.766666667, sign * 34],
    ]);
  runner.expressions = {
    "position.0": runnerX,
    "position.1": `(${ledgeY})-(${curvature})*pow(max(0,(${runnerX})-(${tip})),2)-14*(1-pow(${u},2))`,
  };

  const dive = during(add(world, a.girls.swanDive, 424, -127, 42.5), 2.833333333, c.duration);
  animate(dive, "position.0", [
    [2.833333333, 450],
    [3.066666667, 285],
    [3.266666667, 180],
    [3.666666667, -15],
    [3.766666667, -30],
    [4.066666667, 15],
  ]);
  animate(dive, "position.1", [
    [2.833333333, -127],
    [3.066666667, -105],
    [3.266666667, 30],
  ]);
  // Two accelerating descents meet at entry; water reduces the initial velocity.
  const air = "clamp(time-3.266666667,0,0.4)";
  const water = "max(0,time-3.666666667)";
  const fall = `1350*(${air})+1475*pow(${air},2)+1900*(${water})+1150*pow(${water},2)`;
  dive.expressions = { "position.1": `value+${fall}` };
  animate(dive, "rotation.2", [
    [2.833333333, 0],
    [3.066666667, -105],
    [3.266666667, -155],
    [3.516666667, -180],
  ]);
  for (const axis of ["scale.0", "scale.1"])
    animate(dive, axis, [
      [2.833333333, 42.5],
      [3.266666667, 33],
      [3.466666667, 38],
    ]);

  const crown = during(add(world, p.crown, -800, -28, 32), 1.666666667, 3.25);
  animate(crown, "position.0", [
    [1.666666667, 36],
    [2.266666667, 225],
    [2.766666667, 236],
    [3.25, 70],
  ]);
  animate(crown, "position.1", [
    [1.666666667, -28],
    [2.266666667, -45],
    [2.766666667, -65],
    [3.25, 230],
  ]);
  crown.expressions = { "rotation.2": "-12+205*(time-1.666666667)" };
  const surface = ellipse("Near water surface", 0, 3270, 14000, 5000, P.teal);
  animate(surface, "position.1", [
    [3.6, 3400],
    [3.666666667, 3360],
    [3.766666667, 3270],
  ]);
  world.layers.push(surface);
  world.layers.push(ellipse("Deep water surface", 0, 4200, 20000, 5000, P.blue));
  const shaftBottom = `200+${fall}+30000*pow(max(0,time-4.066666667),2)`;
  const shaft = during(
    rect("Trailing water column", 15, 1600, 128, 2000, P.teal),
    3.933333333,
    c.duration,
  );
  shaft.expressions = {
    "position.1": `(1600+(${shaftBottom}))/2`,
    "scale.1": `max(0,(${shaftBottom})-1600)/20`,
  };
  const cap = during(
    ellipse("Rounded end of the water column", 15, 1600, 128, 128, P.teal),
    3.933333333,
    c.duration,
  );
  cap.expressions = { "position.1": shaftBottom };
  world.layers.push(shaft, cap);

  // The same rig and transform form the submerged silhouette. Crop is evaluated
  // in the final composition, so its top follows the projected waterline.
  const submerged = structuredClone(dive);
  submerged.id = id("layer");
  submerged.name = "Diver below the waterline";
  submerged.inPoint = 3.6;
  submerged.timeOffset = 3.6 - dive.inPoint;
  b.tint(submerged, P.blue);
  const wet = effect(
    "crop",
    { left: 0, right: 0, top: 100, bottom: 0, feather: 1, invert: 0 },
    "Waterline crossing",
  );
  wet.parameterKeyframes = {
    top: track(
      [
        [3.6, 100],
        [3.666666667, 86.7],
        [3.766666667, 61.2],
        [3.866666667, 31.5],
        [3.966666667, 0],
      ],
      linear,
    ).keyframes,
  };
  submerged.effects.push(wet);
  world.layers.push(submerged);

  const splash = during(
    place(
      vector(
        "Entry splash",
        [
          [-22, 0],
          [-9, -170],
          [-7, -300],
          [3, -140],
          [16, -210],
          [21, 0],
        ],
        P.teal,
      ),
      -30,
      770,
    ),
    3.6,
    4,
  );
  animate(splash, "scale.1", [
    [3.6, 0],
    [3.666666667, 12],
    [3.766666667, 100],
    [4, 0],
  ]);
  animate(splash, "position.1", [
    [3.6, 900],
    [3.666666667, 860],
    [3.766666667, 770],
  ]);
  world.layers.push(splash);
  supporting.push(world);

  const camera = add(c, world);
  camera.transform.anchor[0] = constant(0);
  camera.transform.anchor[1] = constant(0);
  animate(
    camera,
    "position.0",
    [
      [0, -1800],
      [0.766666667, -620],
      [1.266666667, -285],
      [2.266666667, 149],
      [2.766666667, 309],
      [3.266666667, 480],
      [3.766666667, 635],
      [4.466666667, 650],
    ],
    linear,
  );
  animate(camera, "position.1", [
    [0, 892],
    [0.766666667, 650],
    [1.266666667, 565],
    [2.266666667, 500],
    [2.766666667, 485],
    [3.266666667, 320, [1 / 3, 0.249, 2 / 3, 0.583]],
    [3.766666667, -220],
  ]);
  camera.expressions = {
    "position.1": "value-2000*max(0,time-3.766666667)-5200*pow(max(0,time-3.766666667),2)",
  };
  for (const axis of ["scale.0", "scale.1"])
    animate(camera, axis, [
      [0, 170],
      [0.766666667, 128],
      [1.266666667, 120],
      [2.266666667, 101.3],
      [2.766666667, 98],
      [3.266666667, 96],
      [4.466666667, 96],
    ]);
  return c;
}
