import {
  animate,
  during,
  effect,
  keyPose,
  line,
  overlay,
  P,
  place,
  rect,
  rgba,
  track,
  vector,
} from "./scenes.mjs";

export function actTwo(b) {
  const { scene, add, circle, stripes, tint, slope, props: p, characters: a } = b;
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
    const hdr = rgba(P.cream).slice(0, 3);
    const gain = Math.max(...hdr);
    flash.parameters.color = hdr.reduce(
      (packed, channel) => packed * 256 + Math.round((channel / gain) * 255),
      0,
    );
    flash.parameterKeyframes = {
      opacity: track([
        [0, 0],
        [0.03, 100],
        [0.333333333, 100],
        [0.4, 0],
      ]).keyframes,
    };
    girl.effects.push(flash);
    const flashExposure = effect(
      "exposure",
      { exposure: 0, offset: 0, gamma: 1 },
      "Flash brightness",
    );
    flashExposure.parameterKeyframes = {
      exposure: track([
        [0, 0],
        [0.03, Math.log2(gain)],
        [0.333333333, Math.log2(gain)],
        [0.4, 0],
      ]).keyframes,
    };
    girl.effects.push(flashExposure);
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
  {
    const c = scene("19 · Lily pads and flowing water", 50.6, 53, P.blue);
    for (let i = 0; i < 23; i++) {
      const flow = line(
        "Water flow",
        [
          [i * 66 - 80, -100, [0, 0], [95, 150]],
          [i * 66 - 45, 320, [-80, -180], [-80, 160]],
          [i * 66 - 80, 948, [90, -230]],
        ],
        P.teal,
        7,
      );
      c.layers.push(flow);
      flow.expressions = { "position.0": "16*sin(time*2.5)" };
    }
    for (const [x, y, s, phase] of [
      [315, 162, 100, 0],
      [940, 610, 72, 1],
      [200, 785, 172, 2],
    ]) {
      const leaf = add(c, p.lily, x, y, s);
      leaf.expressions = {
        "position.0": `${x} + 130*sin(time*0.75+${phase})`,
        "rotation.2": `time*18+${phase * 70}`,
      };
    }
    const crown = add(c, p.crown, 720, 542, 120, 100);
    crown.expressions = { "rotation.2": "100 + time*65", "position.0": "720 + 90*sin(time*3)" };
    const wipe = rect("Teal water wipe", -250, 424, 740, 1400, P.teal);
    c.layers.push(wipe);
    animate(wipe, "position.0", [
      [0, -500],
      [0.8, -500],
      [1.3, 520],
      [2.4, 1650],
    ]);
  }
  {
    const c = scene("20 · Ring reset", 53, 53.633333333, P.green);
    add(c, p.ring, 555, 362, 100);
    add(c, p.ball, 1120, 734, 95, 24);
  }
  {
    const c = scene("21 · Diagonal striped passage", 53.633333333, 55.6, P.teal);
    stripes(c, { angle: -62, spacing: 25, width: 13, fill: P.blue, travel: -105 });
    c.layers.push(rect("Clear water at right", 1230, 424, 780, 1400, P.teal));
    const crown = add(c, p.crown, 70, 393, 134, 95);
    animate(crown, "position.0", [
      [0, -150],
      [0.5, 62],
      [1.967, -130],
    ]);
    const heart = tint(add(c, p.heart, 860, 550, 90, 20), P.green);
    heart.expressions = { "position.0": "860 - 190*time", "rotation.2": "20 + time*18" };
  }
  {
    const c = scene("22 · Together in the swim ring", 55.6, 59.833333333, P.green);
    for (const [x, y, s, speed] of [
      [780, 24, 170, -80],
      [-250, 690, 100, 170],
      [400, 1000, 175, -35],
      [1480, 590, 100, -80],
    ]) {
      const ring = add(c, p.ring, x, y, s, 5);
      ring.expressions = {
        "position.0": `${x}+${speed}*time`,
        "position.1": `${y}+30*sin(time*1.5)`,
        "rotation.2": "value+time*16",
      };
    }
    const ball = add(c, p.ball, 1310, 760, 129);
    ball.expressions = {
      "position.0": "1530 - 460*time",
      "position.1": "760-60*sin(time*1.2)",
      "rotation.2": "time*38",
    };
    const ring = add(c, p.ring, 445, 370, 210, -8);
    ring.expressions = { "position.0": "110+167*time", "rotation.2": "-8+4*sin(time*1.2)" };
    const girl = add(c, a.girls.cuddle, 455, 500, 120, -10);
    girl.expressions = { "position.0": "132+167*time", "rotation.2": "-10+4*sin(time*1.2)" };
    const frog = add(c, a.frog, 525, 330, 66, -7);
    frog.expressions = { "position.0": "183+167*time", "rotation.2": "-7+4*sin(time*1.2)" };
    const crown = add(c, p.crown, 1330, 86, 100);
    crown.expressions = { "position.0": "1920-time*320", "rotation.2": "-6+8*sin(time*2)" };
  }
  {
    const c = scene("23 · Crown accent", 59.833333333, 60.566666667, P.blue);
    const crown = add(c, p.crown, 640, 415, 110, -6);
    animate(crown, "scale.0", [
      [0, 70],
      [0.18, 110],
      [0.7, 100],
    ]);
  }
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
  {
    const c = scene("25 · Echoes in the dark", 61.2, 63.633333333, P.black);
    for (let i = 7; i >= 0; i--) {
      const crown = tint(add(c, p.crown, 640, 424, 90 - i * 3, i * -5), i ? P.teal : P.blue);
      crown.expressions = {
        "position.0": `640+135*sin((time-${i * 0.055})*3.4)`,
        "position.1": `424+270*cos((time-${i * 0.055})*2.6)`,
        "rotation.2": `(time-${i * 0.055})*240`,
      };
      if (i) animate(crown, "opacity", 13 + i * 4);
    }
  }
  {
    const c = scene("26 · Frog, umbrella, and falling crown", 63.633333333, 65.433333333);
    const umbrella = add(c, p.umbrella, 497, 610, 100, -118);
    const frog = add(c, a.frog, 536, 480, 90, 18);
    for (const item of [umbrella, frog]) {
      animate(item, "position.1", [
        [0, item.transform.position[1].value],
        [0.9, item.transform.position[1].value],
        [1.3, 1100],
      ]);
      during(item, 0, 1.3);
    }
    const folded = place(
      vector(
        "Folded crown",
        [
          [-54, -36],
          [-25, -70],
          [0, -38],
          [27, -70],
          [57, -36],
          [57, 74],
          [0, 135],
          [-54, 74],
        ],
        P.cream,
      ),
      830,
      578,
    );
    c.layers.push(during(folded, 1.15, 1.8));
    animate(folded, "position.1", [
      [1.15, -160],
      [1.45, 578],
      [1.8, 700],
    ]);
  }
  {
    const c = scene("27 · Walking with the umbrella", 65.433333333, 66.8);
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
  {
    const c = scene("29 · Umbrella parade", 68.7, 70.633333333, P.green);
    stripes(c, { angle: 24, spacing: 28, width: 10, fill: P.turquoise });
    for (let i = 0; i < 5; i++) {
      const u = tint(add(c, p.umbrella, -200 + i * 310, 420, 76, 80 - i * 27), P.teal);
      u.expressions = {
        "position.0": `${-200 + i * 310} - 320*time`,
        "rotation.2": `${80 - i * 27} - time*40`,
      };
    }
    add(c, a.girls.stand, 1110, 498, 75);
    const cover = rect("Passing blue card", 1610, 110, 1600, 900, P.blue);
    c.layers.push(cover);
    animate(cover, "position.0", [
      [0, 2210],
      [0.9, 2210],
      [1.933, 880],
    ]);
  }
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
  {
    const c = scene("31 · Balancing on a diagonal", 72.6, 74, P.green);
    slope(c, P.teal, [0, 565, 1280, 85]);
    const girl = add(c, a.girls.spread, 650, 495, 74, -8);
    animate(girl, "rotation.2", [
      [0, -8],
      [0.65, 2],
      [1.4, -8],
    ]);
    tint(add(c, p.heart, 160, 451, 130), P.blue);
    tint(add(c, p.crown, 1120, 268, 135), P.green);
  }
  {
    const c = scene("32 · Swimming between the brackets", 74, 74.8);
    slope(c, P.teal, [0, 990, 1280, 240]);
    const frog = add(c, a.frog, 640, 455, 69, 70);
    animate(frog, "position.0", [
      [0, 390],
      [0.8, 910],
    ]);
    for (const [x, y, color] of [
      [370, 150, P.blue],
      [1100, 680, P.turquoise],
    ]) {
      c.layers.push(
        place(
          line(
            "Floating bracket",
            [
              [-90, 50, [0, 0], [20, -70]],
              [90, -50, [-80, -20]],
            ],
            color,
            106,
          ),
          x,
          y,
        ),
      );
    }
  }
  {
    const c = scene("33 · Seesaw", 74.8, 76);
    slope(c, P.green, [0, 220, 1280, 480]);
    c.layers.push(
      vector(
        "Seesaw support",
        [
          [500, 750],
          [760, 750],
          [630, 514],
        ],
        P.teal,
      ),
    );
    const board = rect("Seesaw plank", 633, 525, 1110, 55, P.teal);
    c.layers.push(board);
    add(c, a.girls.sit, 1060, 482, 70, -12);
    add(c, a.frog, 154, 431, 64);
    add(c, p.crab, 455, 480, 65);
    add(c, p.crab, 322, 480, 69);
  }
  {
    const c = scene("34 · Sliding down the slope", 76, 79.6);
    const bank = slope(c, P.teal, [0, 1250, 1280, 370]);
    animate(bank, "rotation.2", [
      [0, -45],
      [0.65, -8],
      [3.6, 18],
    ]);
    const ring = add(c, p.ring, 980, 135, 122);
    keyPose(ring, {
      "position.0": [
        [0, 1270],
        [0.8, 980],
        [1.6, 350],
        [3.6, 270],
      ],
      "position.1": [
        [0, -180],
        [0.8, 140],
        [1.6, 457],
        [3.6, 540],
      ],
      "rotation.2": [
        [0, 0],
        [3.6, -240],
      ],
    });
    const girl = add(c, a.girls.sit, 730, 493, 72, 5);
    keyPose(girl, {
      "position.0": [
        [0, 450],
        [1, 440],
        [2.3, 660],
        [3.6, 755],
      ],
      "position.1": [
        [0, 940],
        [1, 710],
        [2.3, 520],
        [3.6, 476],
      ],
      "rotation.2": [
        [0, -20],
        [2, 8],
      ],
    });
    const frog = add(c, a.frog, 700, 437, 90, 94);
    keyPose(frog, {
      "position.0": [
        [0, 1500],
        [1.1, 1300],
        [2.1, 740],
        [3.6, 155],
      ],
      "position.1": [
        [0, 0],
        [1.1, 230],
        [2.1, 443],
        [3.6, 664],
      ],
    });
    const ball = add(c, p.ball, 1110, 395, 112);
    keyPose(ball, {
      "position.0": [
        [0, 1650],
        [1.5, 1110],
        [3.6, 470],
      ],
      "position.1": [
        [0, 200],
        [1.5, 395],
        [3.6, 580],
      ],
      "rotation.2": [
        [0, 0],
        [3.6, -440],
      ],
    });
    const crown = add(c, p.crown, 990, 485, 115, 88);
    keyPose(crown, {
      "position.0": [
        [0, 430],
        [1.4, 430],
        [2.8, 1080],
        [3.6, 920],
      ],
      "position.1": [
        [0, 640],
        [1.4, 640],
        [2.8, 458],
        [3.6, 500],
      ],
    });
  }
  {
    const c = scene("35 · Standing on the ledge", 79.6, 81.733333333);
    slope(c, P.teal, [0, 740, 1280, 580]);
    const girl = add(c, a.girls.stand, 677, 444, 75, -12);
    keyPose(girl, {
      "rotation.2": [
        [0, -12],
        [0.6, -9],
        [1.3, -2],
      ],
      "position.1": [
        [0, 444],
        [0.65, 435],
      ],
    });
    const crown = add(c, p.crown, 267, 662, 104, -8);
    animate(crown, "position.0", [
      [0, 267],
      [2.133, -290],
    ]);
    const ball = add(c, p.ball, 30, 709, 90);
    animate(ball, "position.0", [
      [0, 30],
      [1, -250],
    ]);
  }
  {
    const c = scene("36 · The dive", 81.733333333, 86.2);
    const light = circle(c, -320, 424, 1040, P.green, "Destination pool");
    animate(light, "position.0", [
      [0, -500],
      [2.7, 600],
    ]);
    const cliff = vector(
      "Cliff edge",
      [
        [0, 0],
        [1200, 0],
        [1200, 155],
      ],
      P.teal,
    );
    c.layers.push(place(cliff, 310, 610));
    keyPose(cliff, {
      "position.0": [
        [0, -40],
        [1.8, 300],
        [2.6, 480],
        [3.5, 885],
        [4.467, 1320],
      ],
      "position.1": [
        [0, 610],
        [2.6, 470],
      ],
      "scale.0": [
        [0, 200],
        [2.6, 100],
      ],
      "scale.1": [
        [0, 200],
        [2.6, 100],
      ],
    });
    const crouch = add(c, a.girls.crouch, 900, 509, 71);
    during(crouch, 0, 2.3);
    keyPose(crouch, {
      "position.0": [
        [0, 900],
        [1.2, 710],
        [2.3, 980],
      ],
      "position.1": [
        [0, 509],
        [1.2, 476],
        [2.3, 436],
      ],
      "scale.0": [
        [0, 71],
        [2.3, 24],
      ],
      "scale.1": [
        [0, 71],
        [2.3, 24],
      ],
    });
    const dive = add(c, a.girls.dive, 980, 436, 24, 0);
    during(dive, 2.3, c.duration);
    keyPose(dive, {
      "position.0": [
        [2.3, 980],
        [3.266666667, 580],
        [4.467, 610],
      ],
      "position.1": [
        [2.3, 436],
        [2.9, 370],
        [3.266666667, 480],
        [3.6, 620],
        [4.467, 930],
      ],
      "rotation.2": [
        [2.3, 0],
        [2.7, -60],
        [3.266666667, -137],
        [4.2, -180],
      ],
    });
    const crown = add(c, p.crown, 469, 485, 28);
    during(crown, 2.3, c.duration);
    animate(crown, "position.0", [
      [2.3, 469],
      [4.46, 1250],
    ]);
  }
}
