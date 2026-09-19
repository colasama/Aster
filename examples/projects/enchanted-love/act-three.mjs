import {
  animate,
  during,
  effect,
  ellipse,
  keyPose,
  line,
  linear,
  overlay,
  P,
  place,
  prop,
  title,
  track,
  vector,
} from "./scenes.mjs";

export function actThree(b) {
  const { scene, add, circle, group, tint, shadow, doorway, props: p, characters: a } = b;
  const beam = (
    c,
    { center = 640, top = 85, bottom = 465, color = P.green, border = false } = {},
  ) => {
    const points = [
      [-top / 2, -5],
      [top / 2, -5],
      [bottom / 2, 855],
      [-bottom / 2, 855],
    ];
    const light = place(
      vector("Trapezoid spotlight", points, color, {
        stroke: border ? P.cream : undefined,
        strokeWidth: border ? 12 : 0,
      }),
      center,
      0,
    );
    c.layers.push(light);
    return light;
  };
  const particles = (c, center = 640, phase = 0, count = 30) => {
    for (let i = 0; i < count; i++) {
      const seed = Math.sin((i + 1) * 12.9898 + phase) * 43758.5453;
      const r = seed - Math.floor(seed);
      const dot = circle(
        c,
        center + (r - 0.5) * 170,
        30 + i * 18,
        8 + r * 12,
        P.cream,
        "Falling spark",
      );
      dot.expressions = {
        "position.1": `-50 + (time*130+${i * 27})-floor((time*130+${i * 27})/820)*820`,
        "position.0": `${center} + ${35 + r * 60}*sin(time*1.8+${i})`,
      };
    }
  };
  {
    const c = scene("37 · Into the shaft of light", 86.2, 88.366666667, P.black);
    const light = beam(c, { top: 205, bottom: 461, border: true });
    animate(light, "scale.0", [
      [0, 25],
      [0.3, 65],
      [0.8, 100],
      [1.8, 82],
      [2.166666667, 105],
    ]);
    particles(c);
    const crown = add(c, p.crown, 625, 590, 97, 35);
    crown.expressions = {
      "position.0": "640+130*sin(time*4.1)",
      "position.1": "430+240*cos(time*3.3)",
      "rotation.2": "30+time*180",
    };
    const heart = tint(add(c, p.heart, 500, 208, 104, -32), P.blue);
    heart.expressions = {
      "position.0": "480+210*sin(time*2.8)",
      "position.1": "100+time*270",
      "rotation.2": "-32+time*150",
    };
  }
  {
    const c = scene("38 · The girl and frog fall through light", 88.366666667, 90.2, P.teal);
    beam(c, { center: 640, top: 265, bottom: 557, color: P.turquoise });
    particles(c, 640, 2, 28);
    const girl = add(c, a.girls.float, 640, 565, 76, -30);
    keyPose(girl, {
      "position.1": [
        [0, 120],
        [0.55, 566],
        [1.83, 1210],
      ],
      "rotation.2": [
        [0, -5],
        [0.9, -25],
        [1.8, -65],
      ],
    });
    const frog = add(c, a.frog, 1100, 530, 66, 90);
    keyPose(frog, {
      "position.0": [
        [0, 1250],
        [0.6, 980],
        [1.83, 900],
      ],
      "position.1": [
        [0, 280],
        [0.8, 620],
        [1.83, 1140],
      ],
    });
    const fish = add(c, p.fish, 620, 436, 66, 0);
    during(fish, 1.3, c.duration);
  }
  {
    const c = scene("39 · Heart between parentheses", 90.2, 90.9, P.black);
    tint(add(c, p.heart, 640, 424, 120), P.green);
    for (const sign of [-1, 1])
      c.layers.push(
        place(
          line(
            "Small parenthesis",
            [
              [sign * 6, -18, [0, 0], [-sign * 21, 12]],
              [sign * 6, 18, [-sign * 21, -12]],
            ],
            P.green,
            4,
          ),
          640 + sign * 200,
          424,
        ),
      );
  }
  {
    const c = scene("40 · Crown rising in a narrow shaft", 90.9, 93.8, "#125165");
    const light = beam(c, { top: 216, bottom: 480, border: true });
    animate(light, "scale.0", [
      [0, 22],
      [0.1, 30],
      [1.1, 100],
      [2.1, 137],
      [2.9, 150],
    ]);
    particles(c, 643, 3, 35);
    const crown = add(c, p.crown, 655, 473, 115);
    crown.expressions = {
      "rotation.2": "20+time*118",
      "position.1": "475+170*sin(time)",
      "position.0": "640+130*sin(time*1.45)",
    };
    const side = tint(add(c, a.girls.float, -200, 560, 90, 4), P.teal);
    animate(side, "position.0", [
      [0, -200],
      [1.6, -200],
      [2.9, 0],
    ]);
  }
  {
    const c = scene("41 · Reunion in the spotlight", 93.8, 95.6, P.black);
    beam(c, { center: 635, top: 335, bottom: 669, border: true });
    // Repeated small chevrons are the woven pool-floor pattern.
    const weave = place(
      line(
        "Repeated woven chevron",
        [
          [-10, -6],
          [0, 5],
          [10, -6],
        ],
        P.turquoise,
        7,
      ),
      623,
      738,
    );
    weave.cloner = {
      distribution: { kind: "grid", count: [9, 9, 1], spacing: [52, 36, 0] },
      effectors: [],
    };
    c.layers.push(weave);
    const seat = place(ellipse("Floating seat", 625, 615, 295, 175, P.blue), 625, 615, 100, -25);
    c.layers.push(seat);
    add(c, a.girls.sit, 640, 540, 68, -8);
    add(c, a.frog, 779, 654, 52, 24);
    const iris = circle(c, 640, 578, 440, P.cream, "Ivory iris");
    during(iris, 0.8, c.duration);
    keyPose(iris, {
      "scale.0": [
        [0.8, 0],
        [1.25, 100],
        [1.8, 700],
      ],
      "scale.1": [
        [0.8, 0],
        [1.25, 100],
        [1.8, 700],
      ],
    });
    for (const [diameter, color, delay] of [
      [240, P.turquoise, 0.1],
      [186, P.cream, 0.15],
      [70, P.green, 0.2],
    ]) {
      const disk = circle(c, 640, 578, diameter, color, "Nested iris");
      during(disk, 0.9 + delay, c.duration);
      keyPose(disk, {
        "scale.0": [
          [0.9 + delay, 0],
          [1.3, 100],
          [1.8, 700],
        ],
        "scale.1": [
          [0.9 + delay, 0],
          [1.3, 100],
          [1.8, 700],
        ],
      });
    }
    animate(seat, "scale.0", [
      [0, 100],
      [0.8, 100],
    ]);
  }
  {
    const c = scene("42 · Drifting pool objects", 95.6, 99.5, P.green);
    for (const [source, x, y, scale, dx, dy] of [
      [p.ball, 230, 50, 156, -300, 175],
      [p.ring, 350, -420, 188, 44, 276],
      [p.stripedBall, 1100, 302, 164, -110, 152],
      [p.ring, -900, -700, 165, 160, 100],
    ]) {
      const shade = shadow(c, source, x, y, scale);
      const item = add(c, source, x, y, scale);
      for (const [node, offset] of [
        [shade, 55],
        [item, 0],
      ])
        node.expressions = {
          "position.0": `${x + offset}+${dx}*time`,
          "position.1": `${y + offset * 1.5}+${dy}*time`,
          "rotation.2": source === p.ring ? "time*28+45" : "time*28-67.2",
        };
      if (source === p.stripedBall) {
        for (const [node, offset] of [
          [shade, 55],
          [item, 0],
        ]) {
          delete node.expressions["position.0"];
          animate(
            node,
            "position.0",
            [
              [0, 1800 + offset],
              [0.8, 1400 + offset],
              [2.4, 836 + offset],
              [3.9, 450 + offset],
            ],
            linear,
          );
        }
      }
    }
    const frog = add(c, a.frog, 452, -80, 61, -6);
    during(frog, 2.7, c.duration);
    animate(frog, "position.1", [
      [2.7, -150],
      [3.9, 135],
    ]);
  }
  {
    const c = scene("43 · Floating back together", 99.5, 104.8, P.green);
    const girl = add(c, a.girls.stand, 170, 450, 73, -22);
    const frog = add(c, a.frog, 728, 534, 61, 9);
    const crown = add(c, p.crown, 517, 168, 61, 0);
    const actors = [girl, frog, crown];
    for (const [i, node] of actors.entries()) {
      node.expressions = {
        "position.0": ["-50+145*time", "530+180*time", "-350+170*time"][i],
        "position.1": ["50+120*time", "120+190*time", "165+50*time"][i],
        "rotation.2": `value+4*sin(time*1.5+${i})`,
      };
    }
    const actorShadow = actors.map((node) => {
      const copy = structuredClone(node);
      copy.id += "-shadow";
      copy.expressions["position.0"] += "+35";
      copy.expressions["position.1"] += "+65";
      return copy;
    });
    c.layers.splice(1, 3);
    group(c, "Pool shadows", actorShadow, P.shadow);
    c.layers.push(...actors);
    const ring = add(c, p.ring, 790, 1250, 188);
    animate(ring, "position.1", [
      [0, 870],
      [1.3, 1250],
    ]);
    const blue = circle(c, 400, -2870, 5900, P.teal, "Blue transition lip");
    const black = circle(c, 400, -2960, 5900, P.black, "Black transition iris");
    for (const [node, offset] of [
      [blue, 90],
      [black, 0],
    ]) {
      animate(node, "position.1", [
        [0, -3900 + offset],
        [2.6, -2950 + offset],
        [5.3, -2500 + offset],
      ]);
    }
  }
  {
    const c = scene("44 · The staircase returns", 104.8, 106.3, P.black);
    const girl = add(c, a.girls.walk, 744, 1100, 75);
    animate(girl, "position.1", [
      [0, 1100],
      [1.5, 470],
    ]);
    const stair = add(c, p.stair, 710, 190, 108);
    animate(stair, "position.1", [
      [0, 1200],
      [1.5, 654],
    ]);
  }
  {
    const c = scene("45 · Walking past the windows", 106.3, 118.5, P.black);
    const stair = line(
      "Four walking steps",
      [
        [-225, -100],
        [-183, -100],
        [-183, -54],
        [-68, -54],
        [-68, -8],
        [47, -8],
        [47, 40],
        [164, 40],
        [164, 88],
        [218, 88],
      ],
      P.cream,
      3,
    );
    stair.expressions = {
      "position.0": "720-90*(time-floor(time/0.64)*0.64)/0.64",
      "position.1": "641-46*(time-floor(time/0.64)*0.64)/0.64",
    };
    const girl = prop(a.girls.walk, 706, 462, 74, -1);
    girl.transform.scale[0] = track(-74);
    group(c, "Walking scene in shadow", structuredClone([stair, girl]), P.blue);
    const litGirl = group(c, "Walking scene in window light", [stair, girl]);
    const crop = effect(
      "crop",
      { left: 0, right: 0, top: 0, bottom: 0, feather: 1, invert: 0 },
      "Moving window beam",
    );
    litGirl.effects.push(crop);
    const leftKeys = [],
      rightKeys = [];
    for (let i = 0; i < 5; i++) {
      const t = i * 2.65 + 0.6;
      const win = add(c, p.window, 1600, 156, 105, -1.4);
      during(win, Math.max(0, t), Math.min(c.duration, t + 3.3));
      keyPose(win, {
        "position.0": [
          [t, 1590],
          [t + 3.3, -200],
        ],
        "position.1": [
          [Math.max(0, t), 141],
          [t + 3.3, 196],
        ],
      });
      animate(
        win,
        "position.0",
        [
          [t, 1590],
          [t + 3.3, -200],
        ],
        linear,
      );
      c.layers.pop();
      c.layers.splice(1, 0, win);
      leftKeys.push([t, 100], [t + 0.281, 100], [t + 2.64, 0]);
      rightKeys.push([t, 0], [t + 0.862, 0], [t + 2.64, 75.4]);
    }
    crop.parameterKeyframes = {
      left: track(leftKeys, linear).keyframes,
      right: track(rightKeys, linear).keyframes,
    };
  }
  {
    const c = scene("46 · Returning to the doorway", 118.5, 121.033333333, P.black);
    doorway(c, 615, 317, 250, 634);
    c.layers.push(
      line(
        "Pedestal",
        [
          [555, 634],
          [555, 500],
          [675, 500],
          [675, 634],
        ],
        P.cream,
        3,
      ),
    );
    const girl = add(c, a.girls.walk, 1030, 454, 65);
    animate(girl, "position.0", [
      [0, 1040],
      [1.4, 728],
      [2.533, 728],
    ]);
    girl.timeRemap = track(
      [
        [0, 0],
        [1.4, 1.4],
        [2.533, 1.4],
      ],
      linear,
    );
    girl.transform.scale[0] = track(-65);
    const unlit = effect(
      "color-overlay",
      { color: 0x093d51, opacity: 100, blendMode: 0 },
      "Doorway shadow",
    );
    unlit.parameterKeyframes = {
      opacity: track([
        [0, 100],
        [0.8, 100],
        [1.4, 0],
      ]).keyframes,
    };
    girl.effects.push(unlit);
    const frog = add(c, a.litFrog, 615, 473, 39);
    animate(frog, "scale.0", [
      [0, 0],
      [1.65, 0],
      [2.2, 39],
    ]);
    animate(frog, "scale.1", [
      [0, 0],
      [1.65, 0],
      [2.2, 39],
    ]);
  }
  {
    const c = scene("47 · The kiss", 121.033333333, 123.8, P.black);
    doorway(c, 615, 317, 250, 634);
    c.layers.push(
      line(
        "Pedestal",
        [
          [555, 634],
          [555, 500],
          [675, 500],
          [675, 634],
        ],
        P.cream,
        3,
      ),
    );
    const frog = add(c, a.litFrog, 615, 473, 39);
    const girl = add(c, a.girls.kiss, 763, 454, 65, -2);
    girl.transform.scale[0] = track(-65);
    girl.effects.push(
      overlay(P.blue, {
        shape: "rectangle",
        center: [78.9, 50],
        size: [42.2, 100],
        feather: 0,
        opacity: 100,
        invert: false,
      }),
    );
    keyPose(girl, {
      "position.0": [
        [0, 764],
        [0.4, 734],
        [1.15, 744],
        [2.1, 755],
      ],
      "rotation.2": [
        [0, -2],
        [0.5, -6],
        [1.1, -1],
        [2.1, 3],
      ],
      "position.1": [
        [0, 454],
        [0.45, 462],
        [1.4, 454],
        [2.1, 480],
      ],
    });
    const crown = add(c, p.crown, 615, 404, 35);
    during(crown, 0.6, c.duration);
    animate(crown, "position.1", [
      [0.6, 387],
      [0.9, 404],
    ]);
    animate(frog, "position.1", [
      [0, 473],
      [0.6, 463],
      [1.1, 473],
    ]);
  }
  {
    const c = scene("48 · Credits", 123.8, 130.1, P.black);
    title(c, true);
    for (const item of c.layers.slice(1))
      animate(item, "opacity", [
        [0, 0],
        [0.8, 100],
        [4.1, 100],
        [4.8, 0],
      ]);
    for (let i = 0; i < 12; i++) {
      const spark = circle(c, 410 + i * 40, 424, 4 + (i % 4), P.turquoise, "Title spark");
      during(spark, 0, 1);
      spark.expressions = { "position.1": `424 + 110*sin(time*5+${i})` };
      animate(spark, "opacity", [
        [0, 70],
        [1, 0],
      ]);
    }
  }
}
