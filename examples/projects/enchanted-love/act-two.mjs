import { comp } from "./authoring.mjs";
import { balancePassage } from "./balance-passage.mjs";
import { divingScene, ledgeScene } from "./dive.mjs";
import { umbrellaParade } from "./parade.mjs";
import { seesawScene, slideScene } from "./playground.mjs";
import { poolFlash } from "./pool-flash.mjs";
import { animate, during, keyPose, line, overlay, P, place, rect, track } from "./scenes.mjs";
import { poolArrival, stripedPassage } from "./striped-passage.mjs";
import { umbrellaAccents } from "./umbrella-accents.mjs";
import { waterPassage } from "./water-passage.mjs";

export function actTwo(b) {
  const { scene, add, tint, slope, props: p, characters: a } = b;
  {
    const c = scene("13 · Crown, heart, and girl", 40.3, 42.633333333);
    const crown = add(c, p.crown, 760, 485, 200);
    during(crown, 0, 1.25);
    animate(crown, "scale.1", [
      [0, 100],
      [0.35, 200],
      [1, 200],
      [1.25, 20],
    ]);
    const heart = add(c, p.heart, 525, 439, 150);
    during(heart, 1.25, c.duration);
    animate(heart, "position.0", [
      [1.25, 760],
      [1.6, 525],
    ]);
    const girl = add(c, a.girls.stand, 820, 469, 95);
    during(girl, 1.25, c.duration);
    animate(girl, "scale.0", [
      [1.25, 0],
      [1.55, 95],
    ]);
  }
  {
    const c = scene("14 · Bar to three hearts", 42.633333333, 44.8);
    const bar = rect("Ivory bar", 470, 438, 316, 69, P.cream);
    c.layers.push(bar);
    during(bar, 0, 0.9);
    animate(bar, "scale.0", [
      [0, 0],
      [0.3, 100],
      [0.7, 100],
      [0.9, 0],
    ]);
    for (let i = 0; i < 3; i++) {
      const heart = add(c, p.heart, 440 + 204 * i, 423, 75);
      during(heart, 0.9, c.duration);
      animate(heart, "scale.1", [
        [0.9, 0],
        [1.1 + i * 0.06, 75],
      ]);
    }
  }
  {
    const c = scene("15 · Two crabs", 44.8, 45.633333333);
    for (let i = 0; i < 2; i++) {
      const crab = add(c, p.crab, 470 + i * 358, 490, 112);
      crab.expressions = {
        "rotation.2": `${i ? -1 : 1}*6*sin(time*12)`,
        "position.1": "490 + 5*sin(time*14)",
      };
      c.layers.push(
        line(
          "Ground stroke",
          [
            [367 + i * 358, 566],
            [594 + i * 358, 566],
          ],
          P.teal,
          4,
        ),
      );
      for (const r of [75, 97])
        c.layers.push(
          place(
            line(
              "Claw echo",
              [
                [0, -r, [0, 0], [36, 45]],
                [0, r, [36, -45]],
              ],
              P.cream,
              5,
            ),
            613 + i * 358,
            476,
          ),
        );
    }
  }
  {
    const c = scene("16 · Ribbon fish", 45.633333333, 46.566666667);
    const fish = add(c, p.fish, 775, 446, 123);
    keyPose(fish, {
      "position.0": [
        [0, 1450],
        [0.4, 730],
        [0.933, -300],
      ],
      "scale.1": [
        [0, 80],
        [0.4, 110],
        [0.93, 75],
      ],
    });
  }
  {
    const c = scene("17 · The crown returns", 46.566666667, 47.733333333);
    const girl = add(c, a.girls.greeting, 438, 400, 78, -4);
    animate(girl, "rotation.2", [
      [0, -4],
      [0.35, -17],
      [0.8, 0],
    ]);
    const crown = add(c, p.crown, 730, 428, 143);
    keyPose(crown, {
      "position.0": [
        [0, 820],
        [0.55, 730],
        [1.167, 452],
      ],
      "position.1": [
        [0, 395],
        [0.55, 415],
        [1.167, 160],
      ],
      "scale.0": [
        [0, 143],
        [1.167, 40],
      ],
      "scale.1": [
        [0, 143],
        [1.167, 40],
      ],
    });
  }
  {
    const c = scene("18 · Sitting to the music", 47.733333333, 50.6);
    const seat = rect("Seat", 375, 699, 250, 248, P.teal);
    c.layers.push(during(seat, 0.4, c.duration));
    c.layers.push(during(rect("Seat landing flash", 375, 770, 260, 114, P.green), 0, 0.4));
    animate(seat, "rotation.2", [
      [0, 0],
      [0.4, 0],
      [1.1, 7],
      [2.867, 11],
    ]);
    const girl = add(c, a.girls.music, 363, 601, 92, -5);
    const flash = overlay(P.cream);
    flash.name = "Landing flash";
    flash.parameterKeyframes = {
      opacity: track([
        [0, 0],
        [0.03, 100],
        [0.333333333, 100],
        [0.4, 0],
      ]).keyframes,
    };
    girl.effects.push(flash);
    keyPose(girl, {
      "position.1": [
        [0, 700],
        [0.266666667, 660],
        [0.433333333, 610],
        [0.6, 601],
      ],
      "rotation.2": [
        [0, -5],
        [0.3, -3],
        [1.2, 3],
        [2.867, 9],
      ],
    });
    const note = add(c, p.note, 740, 360, 62);
    note.expressions = { "position.1": "360 + 14*sin(time*2)", "rotation.2": "3*sin(time*2)" };
    for (const sign of [-1, 1])
      c.layers.push(
        during(
          place(
            line(
              "Landing accent",
              [
                [0, 0],
                [sign * 140, -50],
              ],
              P.cream,
              5,
            ),
            368 + sign * 155,
            806,
          ),
          0.07,
          0.33,
        ),
      );
  }
  waterPassage(b);
  let poolRaft;
  const passage = stripedPassage(b);
  {
    const c = scene("22 · Together in the swim ring", 55.6, 59.833333333, P.green);
    // Pool props move on three shared drifts; no sampled geometry is involved.
    for (const [x, y, scale, angle] of [
      ["431+465*(1-pow(e,-1.6*time))+175*time", "-60+210*time+15*sin(time*2)", 175, "8-18*time"],
      [
        "-475+250*time-25*pow(max(0,time-2.1),2)",
        "800-310*time+60*pow(max(0,time-2.1),2)",
        180,
        "7-12*time",
      ],
      ["400+180*time", "1020+16*sin(time*1.5)+80*pow(max(0,time-2.1),2)", 175, "-10*time"],
    ]) {
      for (const [node, dx, dy] of [
        [b.shadow(c, p.ring, 0, 0, scale), 28, 46],
        [add(c, p.ring, 0, 0, scale), 0, 0],
      ])
        node.expressions = {
          "position.0": `${x}+${dx}`,
          "position.1": `${y}+${dy}`,
          "rotation.2": angle,
        };
    }
    for (const [node, dx, dy] of [
      [b.shadow(c, p.stripedBall, 0, 0, 129), 28, 46],
      [add(c, p.stripedBall, 0, 0, 129), 0, 0],
    ])
      node.expressions = {
        "position.0": `610-173*time-140*pow(max(0,time-2.7),2)+${dx}`,
        "position.1": `1280-260*time+110*pow(max(0,time-2.7),2)+${dy}`,
        "rotation.2": "-16-5*time",
      };
    const raft = comp("Pool · girl holding the frog in a swim ring", 1280, 848, c.duration);
    add(raft, p.ring, 640, 424, 175, 45);
    add(raft, a.girls.cuddle, 630, 555, 118);
    b.supporting.push(raft);
    poolRaft = raft;
    for (const [node, dx, dy] of [
      [b.shadow(c, raft, 640, 424), 25, 45],
      [add(c, raft), 0, 0],
    ]) {
      node.expressions = { "position.0": `649.734-625.607*pow(e,-0.818682*time)+${dx}` };
      keyPose(node, {
        "position.1": [
          [0, 370 + dy],
          [1.5, 370 + dy],
          [2.4, 356 + dy],
          [3, 378 + dy],
          [3.9, 430 + dy],
          [4.2, 403 + dy],
        ],
        "rotation.2": [
          [0, -14],
          [0.4, -12],
          [1.6, -1],
          [2.6, 8],
          [4.2, 16],
        ],
      });
    }
    for (const [node, dx, dy] of [
      [b.shadow(c, p.crown, 0, 0, 113), 28, 46],
      [add(c, p.crown, 0, 0, 113), 0, 0],
    ])
      node.expressions = {
        "position.0": `1735-265*time+${dx}`,
        "position.1": `105-200*pow(time-2.85,2)+${dy}`,
        "rotation.2": "-130+38*time",
      };
    poolArrival(b, passage, c);
  }
  poolFlash(b, poolRaft);
  {
    const c = scene("24 · Ball accent", 60.566666667, 61.2);
    const ball = add(c, p.ball, 640, 550, 115);
    ball.expressions = { "rotation.2": "time*200-60" };
    keyPose(ball, {
      "position.1": [
        [0, 550],
        [0.23, 570],
        [0.3, 70],
        [0.433333333, 160],
        [0.633333333, 330],
      ],
      "scale.0": [
        [0, 80],
        [0.23, 80],
        [0.3, 115],
      ],
      "scale.1": [
        [0, 287],
        [0.23, 310],
        [0.3, 115],
      ],
    });
  }
  umbrellaAccents(b);
  {
    const c = scene("27 · Walking with the umbrella", 65.633333333, 66.8);
    const girl = add(c, a.girls.umbrella, 571, 498, 96);
    girl.expressions = { "position.1": "498+10*sin(time*9.817477)" };
    for (const [x, y, w] of [
      [636, 796, 564],
      [900, 822, 178],
      [280, 831, 251],
    ])
      c.layers.push(
        line(
          "Walking accent",
          [
            [x - w / 2, y],
            [x + w / 2, y - 8],
          ],
          P.cream,
          5,
        ),
      );
  }
  {
    const c = scene("28 · Ball crossing", 66.8, 68.7);
    const ball = add(c, p.stripedBall, 790, 471, 96);
    ball.expressions = { "rotation.2": "time*290" };
    keyPose(ball, {
      "position.0": [
        [0, 820],
        [0.2, 579],
        [0.7, 949],
        [1.2, 750],
        [1.7, 264],
        [1.9, -40],
      ],
      "position.1": [
        [0, 220],
        [0.2, 422],
        [0.7, 538],
        [1.2, 427],
        [1.7, 613],
        [1.9, 630],
      ],
    });
  }
  umbrellaParade(b);
  {
    const c = scene("30 · Shifting horizons", 70.633333333, 72.6, P.blue);
    const horizon = slope(c, P.turquoise, [-300, 415, 1600, 560]);
    animate(horizon, "rotation.2", [
      [0, 0],
      [0.9, -4],
      [1.8, -36],
    ]);
    const crown = tint(add(c, p.crown, 660, 180, 125), P.turquoise);
    const heart = tint(add(c, p.heart, 690, 716, 130), P.blue);
    for (const item of [crown, heart])
      animate(item, "position.0", [
        [0, item.transform.position[0].value],
        [1.967, -500],
      ]);
  }
  balancePassage(b);
  seesawScene(b);
  slideScene(b);
  ledgeScene(b);
  divingScene(b);
}
