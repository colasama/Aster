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
import { createGirlArtwork } from "./character-artwork.mjs";

import { poses } from "./character-poses.mjs";

// A two-step cycle passes through contact, extension, and a bent airborne leg.
const runPhase = "(time*3*pi+0.2*pi)";
const runHip = (sign) =>
  `-22.5+${18 * sign}*cos(${runPhase})+${51 * sign}*sin(${runPhase})-13.5*cos(2*${runPhase})`;
const runKnee = (sign) =>
  `max(0,59.75-${39.5 * sign}*cos(${runPhase})-${4 * sign}*sin(${runPhase})+15.75*cos(2*${runPhase})-35*max(0,sin(2*${runPhase})))`;

export function createCharacters(props) {
  const assets = [];
  const { head, closedHead, swimmingHead, profile, runnerHead, dress } = createGirlArtwork(assets);

  function girl(name, poseName, { cycle = false, shadow = false, closedEyes = false } = {}) {
    const pose = poses[poseName] ?? poses.stand;
    const sideView =
      cycle ||
      poseName === "carry" ||
      poseName === "umbrella" ||
      poseName === "kiss" ||
      poseName === "swanDive";
    const c = comp(`Girl · ${name}`, 400, 760);
    const root = joint("Torso", 200, 324, pose.body);
    const neck = joint("Head pivot", pose.neckX ?? 0, pose.neckY ?? -180, pose.head, root);
    c.layers.push(root, neck);
    const body = parent(place(instance(dress), 0, pose.bodyY ?? -75), root);
    body.transform.scale[1] = constant(pose.bodyScaleY ?? 100);
    if (sideView) body.transform.scale[0] = constant(pose.bodyScaleX ?? 65);
    const face = parent(
      place(
        instance(
          sideView
            ? ["run", "swanDive"].includes(poseName)
              ? runnerHead
              : profile
            : poseName === "cuddle"
              ? swimmingHead
              : closedEyes
                ? closedHead
                : head,
        ),
        0,
        -33,
        pose.headScale ?? 87,
      ),
      neck,
    );
    if (sideView) face.transform.scale[0] = constant(pose.headScale ?? 100);
    if (pose.headScaleY) face.transform.scale[1] = constant(pose.headScaleY);
    const skin = shadow ? P.blue : P.cream;
    const bones = {};
    function limb(side, kind, baseX, baseY, upper, lower, width, upperAngle, lowerAngle) {
      const limbColor =
        sideView && side === "L" && !cycle && !["carry", "swanDive"].includes(poseName)
          ? P.green
          : skin;
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
        const toe = poseName === "run" ? 30 : 48;
        const foot = parent(
          place(
            vector(
              `${side} foot`,
              [
                [-15, -10],
                [15, -10],
                [18, 8],
                [toe, 14, [0, 0], [8, 4]],
                [toe, 24, [8, 0]],
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
          "rotation.2":
            poseName === "run"
              ? `-12-(${runHip(side === "L" ? 1 : -1)})-(${runKnee(side === "L" ? 1 : -1)})`
              : `-22 ${side === "L" ? "+" : "-"} 7*cos((time-1.7)*5.890486)`,
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
      else if (kind === "arm" && ["cuddle", "reunion"].includes(poseName)) {
        const reunion = poseName === "reunion";
        c.layers.push(
          parent(
            ellipse(
              `${side} hand`,
              0,
              lower + (reunion ? 2 : 8),
              reunion ? 12 : 19,
              reunion ? 22 : 33,
              limbColor,
            ),
            lowerJoint,
          ),
        );
      } else if (kind === "arm")
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
    const upperLeg = pose.upperLeg ?? (cycle ? 140 : 165);
    const lowerLeg = pose.lowerLeg ?? (cycle ? 145 : 168);
    limb("L", "leg", -(pose.hipSpacing ?? 25), 0, upperLeg, lowerLeg, 31, pose.hipL, pose.kneeL);
    limb(
      "R",
      "leg",
      pose.hipSpacing ?? 27,
      0,
      pose.rightUpperLeg ?? upperLeg,
      pose.rightLowerLeg ?? lowerLeg,
      31,
      pose.hipR,
      pose.kneeR,
    );
    const neckPaint = parent(
      rect(
        "Neck",
        0,
        (pose.shoulderY ?? -163) - 2,
        pose.neckWidth ?? 31,
        pose.neckHeight ?? 35,
        skin,
        6,
      ),
      root,
    );
    if (!sideView) c.layers.push(neckPaint, body);
    if (["seesaw", "cuddle", "reunion"].includes(poseName))
      for (const x of [-(pose.hipSpacing ?? 25), pose.hipSpacing ?? 27])
        c.layers.push(parent(ellipse("Seated knee", x, -5, 42, 34, skin), root));
    const armUpper = pose.armUpper ?? 95;
    const armLower = pose.armLower ?? 95;
    const shoulderY = pose.shoulderY ?? -163;
    limb(
      "L",
      "arm",
      -(pose.shoulderSpacing ?? 47),
      shoulderY,
      armUpper,
      armLower,
      cycle ? 20 : (pose.armWidth ?? 14),
      pose.shoulderL,
      pose.elbowL,
    );
    if (sideView) c.layers.push(neckPaint, body);
    limb(
      "R",
      "arm",
      pose.shoulderSpacing ?? 47,
      shoulderY,
      pose.rightUpperArm ?? armUpper,
      pose.rightLowerArm ?? armLower,
      cycle ? 20 : (pose.armWidth ?? 14),
      pose.shoulderR,
      pose.elbowR,
    );
    c.layers.push(face);
    if (poseName === "cuddle") {
      // Settle the head and lower the free arm as the raft turns toward the viewer.
      for (const [node, property, start, end] of [
        [face, "scale.0", 110, 98],
        [face, "scale.1", 94, 85],
        [neck, "position.0", 0, 10],
        [neck, "position.1", -196, -182],
        [bones.armL, "rotation.2", 65, 50],
      ])
        animate(node, property, [
          [0, start],
          [1.3, start],
          [3.8, end],
        ]);
    }
    if (poseName === "run") {
      const phase = `sin(${runPhase})`;
      for (const [side, sign] of [
        ["L", 1],
        ["R", -1],
      ]) {
        bones[`leg${side}`].expressions = { "rotation.2": runHip(sign) };
        bones[`leg${side}Lower`].expressions = { "rotation.2": runKnee(sign) };
        bones[`arm${side}`].expressions = { "rotation.2": `-12-${30 * sign}*${phase}` };
        bones[`arm${side}Lower`].expressions = { "rotation.2": `-4+${8 * sign}*${phase}` };
      }
      const reach = (sign) =>
        `${upperLeg}*cos((12+(${runHip(sign)}))*pi/180)+${lowerLeg}*cos((12+(${runHip(sign)})+(${runKnee(sign)}))*pi/180)`;
      root.expressions = { "position.1": `626-max(${reach(1)},${reach(-1)})` };
    } else if (cycle) {
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
    if (poseName === "swanDive") {
      for (const leg of [bones.legL, bones.legR])
        animate(leg, "rotation.2", [
          [0, 15],
          [0.433333333, 15],
          [0.633333333, 0],
        ]);
      for (const arm of [bones.armL, bones.armR])
        animate(arm, "rotation.2", [
          [0, 158],
          [0.433333333, 158],
          [0.633333333, 178],
        ]);
      animate(body, "scale.0", [
        [0, 80],
        [0.433333333, 80],
        [0.633333333, 50],
      ]);
    }
    if (poseName === "recover") {
      for (const leg of [bones.legL, bones.legR])
        animate(leg, "scale.1", [
          [0, 70],
          [0.4, 100],
        ]);
      animate(neck, "position.1", [
        [0, -180],
        [0.4, -202],
      ]);
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
    recover: girl("recovering on the ledge", "recover"),
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
    reunion: girl("reunited on the turtle", "reunion"),
    carry: girl("standing with the frog", "carry"),
    walk: girl("walk cycle", "stand", { cycle: true }),
    run: girl("running cycle", "run", { cycle: true }),
    swanDive: girl("extended dive", "swanDive"),
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
  const profileFrog = structuredClone(frog);
  profileFrog.id = id("comp");
  profileFrog.name = "Frog · turned toward the girl";
  profileFrog.layers = profileFrog.layers.filter(
    (part) => !["Right eye", "Right pupil", "Nostril R"].includes(part.name),
  );
  for (const part of profileFrog.layers) part.id = id("layer");
  assets.push(profileFrog);
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
  return { assets, girls, frog, profileFrog, litFrog, seatedFrog, fallingFrog, seesawFrog };
}
