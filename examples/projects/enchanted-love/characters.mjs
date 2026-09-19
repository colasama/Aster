import {
  comp,
  constant,
  ellipse,
  id,
  instance,
  joint,
  line,
  palette as P,
  parent,
  place,
  rect,
  rgba,
  vector,
} from "./authoring.mjs";

const rest = {
  hipL: 0,
  kneeL: 0,
  hipR: 0,
  kneeR: 0,
  shoulderL: 8,
  elbowL: -3,
  shoulderR: -8,
  elbowR: 3,
  body: 0,
  head: 0,
};
export const poses = {
  stand: rest,
  sit: {
    ...rest,
    upperLeg: 110,
    lowerLeg: 185,
    hipL: -42,
    kneeL: 39,
    hipR: -49,
    kneeR: 46,
    shoulderL: -3,
    elbowL: -45,
    shoulderR: -14,
    elbowR: 27,
    body: 14,
    head: 12,
  },
  float: {
    ...rest,
    hipL: 24,
    kneeL: -35,
    hipR: -42,
    kneeR: 76,
    shoulderL: 45,
    elbowL: -72,
    shoulderR: -62,
    elbowR: 15,
    body: -12,
    head: 8,
  },
  spread: {
    ...rest,
    hipL: 28,
    kneeL: -38,
    hipR: -50,
    kneeR: 22,
    shoulderL: 75,
    elbowL: -4,
    shoulderR: -104,
    elbowR: 8,
    body: -28,
    head: 20,
  },
  umbrella: {
    ...rest,
    hipL: -45,
    kneeL: 62,
    hipR: 4,
    kneeR: 16,
    shoulderL: 4,
    elbowL: 3,
    shoulderR: 4,
    elbowR: -138,
    body: 4,
    head: -12,
  },
  crouch: {
    ...rest,
    hipL: -65,
    kneeL: 125,
    hipR: -53,
    kneeR: 119,
    shoulderL: 22,
    elbowL: -100,
    shoulderR: -18,
    elbowR: -120,
    body: 22,
    head: -20,
  },
  kiss: {
    ...rest,
    upperLeg: 145,
    lowerLeg: 185,
    hipL: -14,
    kneeL: 8,
    hipR: -24,
    kneeR: 12,
    shoulderL: -15,
    elbowL: -60,
    shoulderR: -20,
    elbowR: -75,
    body: 14,
    head: 8,
  },
  cuddle: {
    ...rest,
    upperLeg: 120,
    lowerLeg: 140,
    rightUpperLeg: 110,
    rightLowerLeg: 95,
    armUpper: 75,
    armLower: 85,
    shoulderY: -145,
    neckY: -190,
    headScale: 105,
    hipL: -8,
    kneeL: 28,
    hipR: -9,
    kneeR: -22,
    shoulderL: 70,
    elbowL: 4,
    shoulderR: -65,
    elbowR: 92,
    body: 0,
    head: 0,
  },
  dive: {
    ...rest,
    shoulderL: 172,
    elbowL: 4,
    shoulderR: -172,
    elbowR: -4,
    hipL: 2,
    hipR: -2,
  },
  carry: { ...rest, upperLeg: 145, lowerLeg: 185 },
  lap: {
    ...rest,
    upperLeg: 110,
    lowerLeg: 145,
    hipL: -15,
    kneeL: 43,
    hipR: -40,
    kneeR: 42,
    shoulderL: 5,
    elbowL: -55,
    shoulderR: -8,
    elbowR: 64,
    body: 0,
    head: -8,
  },
  greeting: { ...rest, shoulderL: 165, elbowL: -25, shoulderR: -24, elbowR: 0, body: 12, head: -8 },
};

export function createCharacters(props) {
  const assets = [];
  const head = comp("Girl · head", 160, 180);
  head.layers = [
    place(
      vector(
        "Hair silhouette",
        [
          [-59, 30, [0, 0], [-1, -46]],
          [-43, -62, [-18, 26], [25, -28]],
          [41, -65, [-24, -25], [24, 10]],
          [62, 20, [0, -26], [-1, 27]],
          [50, 58, [10, -3], [-2, -9]],
          [41, 53, [2, 4], [-14, 15]],
          [-43, 53, [12, 16], [-1, 8]],
          [-61, 61, [4, -1], [7, -24]],
        ],
        P.turquoise,
      ),
      80,
      92,
    ),
    place(
      vector(
        "Face",
        [
          [-48, -15, [0, 0], [0, -9]],
          [-36, -41, [0, 0], [0, 0]],
          [-11, -10, [0, 0], [0, 0]],
          [6, -17, [0, 0], [0, 0]],
          [48, -9, [0, 0], [-3, 44]],
          [0, 49, [29, 0], [-30, 0]],
          [-48, -15, [-3, 38]],
        ],
        P.cream,
      ),
      80,
      83,
    ),
    place(
      vector(
        "Forelock",
        [
          [0, -15],
          [10, -29],
          [18, -26],
          [10, -10],
        ],
        P.blue,
      ),
      80,
      83,
    ),
    place(
      vector(
        "Hair tuft",
        [
          [0, 0],
          [-2, -18],
          [13, -31],
          [13, -12],
        ],
        P.turquoise,
      ),
      88,
      10,
    ),
    ellipse("Left iris", 52, 88, 13, 29, P.blue),
    ellipse("Right iris", 110, 88, 13, 29, P.blue),
    line(
      "Left eyelid",
      [
        [33, 74],
        [71, 78],
      ],
      P.blue,
      5,
    ),
    line(
      "Right eyelid",
      [
        [91, 77],
        [129, 73],
      ],
      P.blue,
      5,
    ),
    line(
      "Left eyebrow",
      [
        [45, 60],
        [60, 60],
      ],
      P.turquoise,
      2,
    ),
  ];
  assets.push(head);
  const closedHead = structuredClone(head);
  closedHead.id = id("comp");
  closedHead.name = "Girl · closed eyes";
  closedHead.layers = closedHead.layers.filter((part) => !part.name.endsWith("iris"));
  for (const part of closedHead.layers) {
    part.id = id("layer");
  }
  assets.push(closedHead);
  const profile = comp("Girl · profile head", 140, 180);
  profile.layers = [
    place(
      vector(
        "Hair silhouette",
        [
          [-40, 36, [-4, 5], [-16, -54]],
          [-36, -50, [-14, 19], [34, -42]],
          [47, -34, [-11, -25], [12, 16]],
          [43, 21, [14, -35]],
          [16, 44, [14, -2]],
          [-13, 45, [12, 2]],
          [-27, 35],
          [-43, 54],
        ],
        P.green,
      ),
      70,
      90,
    ),
    place(
      vector(
        "Profile face",
        [
          [18, -9],
          [41, -16],
          [46, 11],
          [58, 24],
          [46, 28],
          [42, 53],
          [13, 49],
        ],
        P.cream,
      ),
      65,
      71,
    ),
    ellipse("Profile eye", 103, 77, 7, 23, P.blue),
    place(
      vector(
        "Hair tuft",
        [
          [0, 0],
          [-5, -14],
          [10, -26],
          [8, -8],
        ],
        P.green,
      ),
      60,
      19,
    ),
  ];
  assets.push(profile);
  const dress = comp("Girl · tunic", 140, 190);
  dress.layers = [
    place(
      vector(
        "Sleeveless tunic",
        [
          [-38, -85, [0, 0], [-5, 34]],
          [-49, 63, [8, -34], [-4, 10]],
          [0, 82, [-35, -3], [32, -2]],
          [50, 65, [0, 14], [-9, -40]],
          [38, -85, [5, 34], [0, 0]],
          [22, -84],
          [17, -72, [0, 0], [-4, 5]],
          [-17, -72, [4, 4], [-4, -3]],
          [-22, -85],
        ],
        P.blue,
      ),
      70,
      95,
    ),
  ];
  assets.push(dress);

  function girl(name, poseName, { cycle = false, shadow = false, closedEyes = false } = {}) {
    const pose = poses[poseName] ?? rest;
    const sideView =
      cycle || poseName === "carry" || poseName === "umbrella" || poseName === "kiss";
    const c = comp(`Girl · ${name}`, 400, 760);
    const root = joint("Torso", 200, 324, pose.body);
    const neck = joint("Head pivot", 0, pose.neckY ?? -180, pose.head, root);
    c.layers.push(root, neck);
    const body = parent(place(instance(dress), 0, -75), root);
    if (sideView) body.transform.scale[0] = constant(65);
    const face = parent(
      place(
        instance(sideView ? profile : closedEyes ? closedHead : head),
        0,
        -33,
        pose.headScale ?? 87,
      ),
      neck,
    );
    if (sideView) face.transform.scale[0] = constant(100);
    const skin = shadow ? P.blue : P.cream;
    const bones = {};
    function limb(side, kind, baseX, baseY, upper, lower, width, upperAngle, lowerAngle) {
      const limbColor = sideView && side === "L" && !cycle && poseName !== "carry" ? P.green : skin;
      const upperJoint = joint(
        `${side} ${kind} · upper`,
        sideView ? baseX * 0.25 : baseX,
        baseY,
        upperAngle,
        root,
      );
      const lowerJoint = joint(`${side} ${kind} · lower`, 0, upper, lowerAngle, upperJoint);
      const first = parent(
        rect(
          `${side} ${kind} · upper limb`,
          0,
          upper / 2,
          width,
          upper + width,
          limbColor,
          width / 2,
        ),
        upperJoint,
      );
      const second = parent(
        rect(
          `${side} ${kind} · lower limb`,
          0,
          lower / 2,
          kind === "leg" ? width : width * 0.92,
          lower + width,
          limbColor,
          width / 2,
        ),
        lowerJoint,
      );
      c.layers.push(upperJoint, lowerJoint, first, second);
      bones[`${kind}${side}`] = upperJoint;
      bones[`${kind}${side}Lower`] = lowerJoint;
      if (cycle && kind === "leg") {
        const foot = parent(
          place(
            vector(
              `${side} foot`,
              [
                [-15, -10],
                [15, -10],
                [18, 8],
                [48, 14, [0, 0], [8, 4]],
                [48, 24, [8, 0]],
                [-14, 24, [0, 0], [-4, -4]],
              ],
              skin,
            ),
            0,
            lower,
          ),
          lowerJoint,
        );
        foot.expressions = {
          "rotation.2": `-22 ${side === "L" ? "+" : "-"} 7*cos((time-1.7)*5.890486)`,
        };
        c.layers.push(foot);
      }
      if (kind === "arm")
        c.layers.push(
          parent(
            place(
              vector(
                `${side} hand`,
                [
                  [-8, -8],
                  [-12, 4],
                  [-15, 18],
                  [-9, 14],
                  [-5, 8],
                  [0, 14],
                  [7, 16],
                  [8, 4],
                  [7, -7],
                ],
                limbColor,
              ),
              0,
              lower,
            ),
            lowerJoint,
          ),
        );
    }
    const upperLeg = cycle ? 140 : (pose.upperLeg ?? 165);
    const lowerLeg = cycle ? 145 : (pose.lowerLeg ?? 168);
    limb("L", "leg", -25, 0, upperLeg, lowerLeg, 31, pose.hipL, pose.kneeL);
    limb(
      "R",
      "leg",
      27,
      0,
      pose.rightUpperLeg ?? upperLeg,
      pose.rightLowerLeg ?? lowerLeg,
      31,
      pose.hipR,
      pose.kneeR,
    );
    const neckPaint = parent(rect("Neck", 0, -165, 31, 35, skin, 6), root);
    if (!sideView) c.layers.push(neckPaint, body);
    const armUpper = pose.armUpper ?? 95;
    const armLower = pose.armLower ?? 95;
    const shoulderY = pose.shoulderY ?? -163;
    limb(
      "L",
      "arm",
      -47,
      shoulderY,
      armUpper,
      armLower,
      cycle ? 20 : 14,
      pose.shoulderL,
      pose.elbowL,
    );
    if (sideView) c.layers.push(neckPaint, body);
    limb(
      "R",
      "arm",
      47,
      shoulderY,
      armUpper,
      armLower,
      cycle ? 20 : 14,
      pose.shoulderR,
      pose.elbowR,
    );
    c.layers.push(face);
    if (cycle) {
      bones.legL.expressions = { "rotation.2": "-20 + 35*cos((time-1.7)*5.890486)" };
      bones.legR.expressions = { "rotation.2": "-20 - 35*cos((time-1.7)*5.890486)" };
      bones.legLLower.expressions = { "rotation.2": "42 - 42*cos((time-1.7)*5.890486)" };
      bones.legRLower.expressions = { "rotation.2": "42 + 42*cos((time-1.7)*5.890486)" };
      bones.armL.expressions = { "rotation.2": "-2 - 5*cos((time-1.7)*5.890486)" };
      bones.armR.expressions = { "rotation.2": "-2 + 5*cos((time-1.7)*5.890486)" };
      root.expressions = { "position.1": "value - 4*cos((time-1.7)*11.780972)" };
    }
    if (poseName === "float") {
      bones.legL.expressions = { "rotation.2": "value + 9*sin(time*3.14159265)" };
      bones.legRLower.expressions = { "rotation.2": "value + 12*sin(time*3.14159265+1)" };
    }
    if (!cycle) neck.expressions = { "rotation.2": "value + 3*sin(time*2.4)" };
    if (poseName === "umbrella")
      c.layers.push(parent(place(instance(props.umbrella), -40, -247, 104, -39), root));
    assets.push(c);
    return c;
  }
  const girls = {
    stand: girl("standing", "stand"),
    sit: girl("seated", "sit"),
    music: girl("seated with closed eyes", "sit", { closedEyes: true }),
    greeting: girl("reaching for the crown", "greeting"),
    float: girl("floating", "float"),
    spread: girl("balance", "spread"),
    umbrella: girl("umbrella", "umbrella"),
    crouch: girl("crouching", "crouch"),
    kiss: girl("kiss", "kiss"),
    cuddle: girl("holding the frog", "cuddle", { closedEyes: true }),
    dive: girl("diving", "dive"),
    lap: girl("seated with the frog", "lap"),
    carry: girl("standing with the frog", "carry"),
    walk: girl("walk cycle", "stand", { cycle: true }),
  };

  const frog = comp("Frog · puppet", 240, 280);
  frog.layers = [
    place(rect("Left thigh", 64, 209, 38, 70, P.turquoise, 19), 64, 209, 100, 28),
    place(rect("Right thigh", 179, 208, 36, 72, P.turquoise, 18), 179, 208, 100, -28),
    ellipse("Torso", 120, 161, 94, 126, P.turquoise),
    ellipse("Belly", 120, 164, 65, 114, P.cream),
    place(rect("Left arm", 56, 160, 28, 66, P.turquoise, 14), 56, 160, 100, 32),
    place(rect("Right arm", 184, 160, 28, 66, P.turquoise, 14), 184, 160, 100, -32),
    place(
      vector(
        "Head",
        [
          [-77, -8, [-1, 14], [0, -29]],
          [-46, -41, [-25, -6], [26, -5]],
          [48, -39, [-30, -7], [31, -4]],
          [77, -8, [4, -20], [0, 28]],
          [0, 46, [55, 0], [-54, 0]],
        ],
        P.turquoise,
      ),
      120,
      76,
    ),
    ellipse("Left eye", 81, 62, 31, 30, P.cream),
    ellipse("Right eye", 161, 59, 32, 31, P.cream),
    line(
      "Left pupil",
      [
        [69, 62],
        [91, 58],
      ],
      P.blue,
      8,
    ),
    line(
      "Right pupil",
      [
        [150, 58],
        [172, 59],
      ],
      P.blue,
      8,
    ),
    place(
      vector(
        "Smile",
        [
          [-51, -7, [0, 0], [31, 8]],
          [53, -11, [-24, 7], [-6, 31]],
          [-45, 6, [20, 26], [-8, -4]],
        ],
        P.cream,
      ),
      120,
      98,
    ),
    ellipse("Nostril L", 113, 80, 3, 3, P.blue),
    ellipse("Nostril R", 127, 80, 3, 3, P.blue),
  ];
  assets.push(frog);
  const litFrog = structuredClone(frog);
  litFrog.id = id("comp");
  litFrog.name = "Frog · green light";
  const bodyColor = rgba(P.turquoise);
  for (const part of litFrog.layers) {
    part.id = id("layer");
    if (part.color.every((channel, index) => channel === bodyColor[index]))
      part.color = rgba(P.green);
  }
  assets.push(litFrog);
  for (const pose of [girls.walk, girls.carry]) {
    const torso = pose.layers.find((l) => l.name === "Torso");
    pose.layers.push(parent(place(instance(litFrog, "Carried frog"), -25, 60, 44, 20), torso));
  }
  return { assets, girls, frog, litFrog };
}
