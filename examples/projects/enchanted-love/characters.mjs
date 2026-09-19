import {
  animate,
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

import { poses } from "./character-poses.mjs";

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
    const pose = poses[poseName] ?? poses.stand;
    const sideView =
      cycle || poseName === "carry" || poseName === "umbrella" || poseName === "kiss";
    const c = comp(`Girl · ${name}`, 400, 760);
    const root = joint("Torso", 200, 324, pose.body);
    const neck = joint("Head pivot", pose.neckX ?? 0, pose.neckY ?? -180, pose.head, root);
    c.layers.push(root, neck);
    const body = parent(place(instance(dress), 0, pose.bodyY ?? -75), root);
    body.transform.scale[1] = constant(pose.bodyScaleY ?? 100);
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
      if (kind === "arm" && poseName === "seesaw")
        c.layers.push(
          parent(
            place(
              vector(
                `${side} palm resting on the plank`,
                [
                  [-7, -7],
                  [7, -7],
                  [side === "L" ? 10 : 30, 5, [0, -3], [-12, 2]],
                  [side === "L" ? -30 : -10, 5, [12, 2], [0, -3]],
                ],
                limbColor,
              ),
              0,
              lower,
              100,
              -upperAngle - lowerAngle,
            ),
            lowerJoint,
          ),
        );
      else if (kind === "arm" && poseName === "cuddle")
        c.layers.push(parent(ellipse(`${side} hand`, 0, lower + 8, 19, 33, limbColor), lowerJoint));
      else if (kind === "arm")
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
    const neckPaint = parent(rect("Neck", 0, (pose.shoulderY ?? -163) - 2, 31, 35, skin, 6), root);
    if (!sideView) c.layers.push(neckPaint, body);
    if (poseName === "seesaw")
      for (const x of [-25, 27])
        c.layers.push(parent(ellipse("Seated knee", x, -5, 42, 34, skin), root));
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
      pose.rightUpperArm ?? armUpper,
      pose.rightLowerArm ?? armLower,
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
    if (poseName === "slide") {
      // Reach from behind the bank, protect the head, then unfold the legs to stand.
      for (const [bone, values] of [
        [
          bones.armL,
          [
            [0, 12],
            [1.5, 12],
            [2, 158],
            [2.4, 30],
            [3.2, 12],
          ],
        ],
        [
          bones.armLLower,
          [
            [0, -65],
            [1.5, -65],
            [2, -150],
            [2.4, -35],
            [3.2, -125],
          ],
        ],
        [
          bones.armR,
          [
            [0, -35],
            [1.5, -35],
            [2, -18],
            [2.4, -35],
            [3.2, -12],
          ],
        ],
        [
          bones.armRLower,
          [
            [0, 80],
            [1.5, 80],
            [2, 12],
            [2.4, 55],
            [3.2, 125],
          ],
        ],
        [
          bones.legL,
          [
            [0, 68],
            [2, 68],
            [2.5, 30],
            [3.25, 0],
          ],
        ],
        [
          bones.legLLower,
          [
            [0, -39],
            [2, -39],
            [2.5, -15],
            [3.25, 0],
          ],
        ],
        [
          bones.legR,
          [
            [0, -60],
            [2, -60],
            [2.5, -25],
            [3.25, -18],
          ],
        ],
        [
          bones.legRLower,
          [
            [0, 105],
            [2, 105],
            [2.5, 55],
            [3.25, 35],
          ],
        ],
        [
          root,
          [
            [0, 0],
            [1.5, 0],
            [2, 20],
            [2.4, 40],
            [3.2, 0],
          ],
        ],
      ])
        animate(bone, "rotation.2", values);
    }
    if (!cycle && !["cuddle", "seesaw", "slide"].includes(poseName))
      neck.expressions = { "rotation.2": "value + 3*sin(time*2.4)" };
    if (poseName === "umbrella")
      c.layers.push(parent(place(instance(props.umbrella), -40, -247, 104, -39), root));
    assets.push(c);
    return c;
  }
  const girls = {
    stand: girl("standing", "stand"),
    sit: girl("seated", "sit"),
    seesaw: girl("seated on a plank", "seesaw"),
    slide: girl("sliding on the bank", "slide"),
    music: girl("seated with closed eyes", "sit", { closedEyes: true }),
    greeting: girl("reaching for the crown", "greeting"),
    float: girl("floating", "float"),
    spread: girl("balance", "spread"),
    umbrella: girl("umbrella", "umbrella"),
    parade: girl("holding an umbrella from the front", "parade"),
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
    place(rect("Left thigh", 94, 232, 29, 78, P.turquoise, 14), 94, 232, 100, 6),
    place(rect("Right thigh", 152, 232, 29, 78, P.turquoise, 14), 152, 232, 100, -6),
    ellipse("Torso", 120, 161, 94, 126, P.turquoise),
    ellipse("Belly", 120, 164, 65, 114, P.cream),
    place(rect("Left arm", 56, 160, 28, 66, P.turquoise, 14), 56, 160, 100, 32),
    place(rect("Right arm", 184, 160, 28, 66, P.turquoise, 14), 184, 160, 100, -32),
    place(
      vector(
        "Head",
        [
          [-69, -8, [-1, 14], [0, -29]],
          [-42, -41, [-23, -6], [24, -5]],
          [43, -39, [-27, -7], [28, -4]],
          [69, -8, [4, -20], [0, 28]],
          [0, 46, [50, 0], [-49, 0]],
        ],
        P.turquoise,
      ),
      120,
      76,
    ),
    ellipse("Left eye", 81, 62, 38, 38, P.cream),
    ellipse("Right eye", 161, 59, 38, 38, P.cream),
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
  const seatedFrog = structuredClone(litFrog);
  seatedFrog.id = id("comp");
  seatedFrog.name = "Frog · seated in the doorway";
  const folded = [
    place(rect("Left thigh", 48, 223, 42, 64, P.green, 21), 48, 223, 100, -12),
    place(rect("Right thigh", 192, 223, 42, 64, P.green, 21), 192, 223, 100, 12),
    ellipse("Torso", 120, 173, 108, 154, P.green),
    ellipse("Belly", 120, 185, 66, 114, P.cream),
    place(rect("Left arm", 76, 179, 24, 114, P.green, 12), 76, 179, 100, 23),
    place(rect("Right arm", 166, 179, 24, 114, P.green, 12), 166, 179, 100, -23),
  ];
  seatedFrog.layers = seatedFrog.layers.map((part) => {
    part.id = id("layer");
    return folded.find((replacement) => replacement.name === part.name) ?? part;
  });
  for (const side of [-1, 1])
    seatedFrog.layers.push(
      line(
        "Folded foot",
        [
          [120 + side * 36, 240, [0, 0], [side * 30, 7]],
          [120 + side * 88, 247, [-side * 18, 8], [side * 12, -2]],
          [120 + side * 98, 222, [0, 12]],
        ],
        P.cream,
        4,
      ),
    );
  assets.push(seatedFrog);
  const fallingFrog = structuredClone(seatedFrog);
  fallingFrog.id = id("comp");
  fallingFrog.name = "Frog · falling with extended feet";
  fallingFrog.layers = fallingFrog.layers.filter((part) => part.name !== "Folded foot");
  for (const part of fallingFrog.layers) {
    part.id = id("layer");
    if (part.name.endsWith("thigh")) part.transform.position[1] = constant(263);
  }
  assets.push(fallingFrog);
  const seesawFrog = structuredClone(seatedFrog);
  seesawFrog.id = id("comp");
  seesawFrog.name = "Frog · seated on a plank";
  seesawFrog.layers = seesawFrog.layers.filter((part) => part.name !== "Folded foot");
  const green = rgba(P.green);
  for (const part of seesawFrog.layers) {
    part.id = id("layer");
    if (part.color.every((channel, index) => channel === green[index])) part.color = rgba(P.teal);
  }
  assets.push(seesawFrog);
  const cuddle = girls.cuddle;
  const cuddleTorso = cuddle.layers.find((part) => part.name === "Torso");
  cuddle.layers.splice(
    cuddle.layers.findIndex((part) => part.name === "R arm · upper limb"),
    0,
    parent(place(instance(frog, "Frog held under the forearm"), 50, -64, 64, 8), cuddleTorso),
  );
  for (const pose of [girls.walk, girls.carry]) {
    const torso = pose.layers.find((l) => l.name === "Torso");
    pose.layers.push(parent(place(instance(litFrog, "Carried frog"), -25, 60, 44, 20), torso));
  }
  return { assets, girls, frog, litFrog, seatedFrog, fallingFrog, seesawFrog };
}
