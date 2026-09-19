import { createDriftingPool } from "./drifting-pool.mjs";
import {
  animate,
  during,
  effect,
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
import { shaftReunion } from "./shaft-reunion.mjs";

export function actThree(b) {
  const { scene, add, circle, group, tint, doorway, props: p, characters: a } = b;
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
      "position.0": "640+130*cos(time*0.8)",
      "position.1": "430-240*cos(time*3.3)",
      "rotation.2": "35-time*70",
    };
    const heart = tint(add(c, p.heart, 500, 208, 104, -32), P.blue);
    heart.expressions = {
      "position.0": "500+50*sin(time*2.8)",
      "position.1": "-15+time*270",
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
  shaftReunion(b);
  const current = createDriftingPool(b);
  {
    const c = scene("42 · Drifting pool objects", 95.6, 99.5, P.green);
    add(c, current);
  }
  {
    const c = scene("43 · Floating back together", 99.5, 105.3, P.green);
    add(c, current).timeOffset = 3.9;
    // Two expanding circles share the camera advance. Fit the center, edge and
    // inverse radius, rather than drawing a succession of curved wipe contours.
    const u = "(time-3.5)";
    for (const [name, color, x, radius, edge] of [
      [
        "Teal transition lip",
        P.teal,
        `407.13+66.78*${u}`,
        `1/(0.000529027-0.000193669*${u}-0.00000308754*pow(${u},2))`,
        `85.39+383.585*${u}-18.316*pow(${u},2)+22.120*pow(${u},3)`,
      ],
      [
        "Black transition iris",
        P.black,
        `417.76+77.125*${u}`,
        `1/(0.000599682-0.000205034*${u}+0.00000142974*pow(${u},2))`,
        `-44.88+413.322*${u}-34.602*pow(${u},2)+23.106*pow(${u},3)`,
      ],
    ]) {
      const node = circle(c, 400, -2000, 4000, color, name);
      during(node, 3.1, c.duration);
      node.expressions = {
        "position.0": x,
        "position.1": `${edge}-(${radius})`,
        "scale.0": `(${radius})/20`,
        "scale.1": `(${radius})/20`,
      };
    }
  }
  {
    const c = scene("44 · The staircase returns", 105.3, 106.3, P.black);
    const girl = add(c, a.girls.walk, 860, -450, 74, -1);
    girl.transform.scale[0] = track(-74);
    girl.timeOffset = 0.066666667;
    animate(girl, "position.1", [
      [0, -450, [0.33, 0.45, 0.67, 0.8]],
      [1, 100],
    ]);
    const stair = add(c, p.stair, 792, -250, 120);
    animate(stair, "position.1", [
      [0, -250, [0.33, 0.45, 0.67, 0.8]],
      [1, 290],
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
      "position.0": "value-90*(time-floor(time/0.64)*0.64)/0.64",
      "position.1": "value-46*(time-floor(time/0.64)*0.64)/0.64",
    };
    keyPose(stair, {
      "position.0": [
        [0, 819],
        [1.7, 833],
        [4.7, 720],
        [7, 755],
        [9.7, 794],
        [12.2, 760],
      ],
      "position.1": [
        [0, 283, [0.33, 0.5, 0.67, 0.84]],
        [1.7, 589],
        [4.7, 641],
        [7, 657],
        [9.7, 681],
        [12.2, 680],
      ],
    });
    const girl = prop(a.girls.walk, 706, 462, 74, -1);
    girl.transform.scale[0] = track(-74);
    keyPose(girl, {
      "position.0": [
        [0, 860],
        [1.7, 810],
        [4.7, 706],
        [7, 750],
        [9.7, 800],
        [12.2, 760],
      ],
      "position.1": [
        [0, 100, [0.33, 0.5, 0.67, 0.84]],
        [1.7, 377],
        [4.7, 462],
        [7, 478],
        [9.7, 492],
        [12.2, 492],
      ],
    });
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
    // Three windows follow the camera's rightward parallax and downward drift.
    const windowPaths = [
      [
        [0, 958, -150],
        [0.7, 1095, -10],
        [1.7, 1297, 184],
        [2.2, 1400, 275],
      ],
      [
        [2.2, 315, -100],
        [4.7, 805, 161],
        [6.6, 1225, 359],
      ],
      [
        [6.6, 145, -40],
        [9.7, 965, 237],
        [12.2, 1615, 376],
      ],
    ];
    for (const points of windowPaths) {
      const win = add(c, p.window, points[0][1], points[0][2], 105, -1.4);
      during(win, points[0][0], points.at(-1)[0]);
      animate(win, "scale.1", 96);
      animate(
        win,
        "position.0",
        points.map(([t, x]) => [t, x]),
        linear,
      );
      animate(
        win,
        "position.1",
        points.map(([t, , y]) => [t, y]),
        linear,
      );
      c.layers.pop();
      c.layers.splice(1, 0, win);
      for (const [index, [t, x]] of points.entries()) {
        const boundary = index === points.length - 1 ? "hold" : linear;
        const keyTime = boundary === "hold" ? t - 1 / 30 : t;
        leftKeys.push([keyTime, Math.max(0, Math.min(100, ((x - 157) / 1280) * 100)), boundary]);
        rightKeys.push([
          keyTime,
          Math.max(0, Math.min(100, ((1280 - x - 157) / 1280) * 100)),
          boundary,
        ]);
      }
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
    during(girl, 0, 1.4);
    const standing = add(c, a.girls.carry, 728, 454, 65);
    standing.transform.scale[0] = track(-65);
    during(standing, 1.4, c.duration);
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
