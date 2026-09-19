import { animate, comp, during, id, palette as P, track } from "./authoring.mjs";

export function createDriftingPool(b) {
  const c = comp("Pool · continuous current and riders", 1280, 848, 9.7);
  const objects = [];
  const add = (source, scale, x, y, angle, end = c.duration) => {
    const item = during(b.add(c, source, 0, 0, scale), 0, end);
    item.expressions = { "position.0": x, "position.1": y, "rotation.2": angle };
    objects.push(item);
    return item;
  };

  // One ball changes panel orientation while the current bends its travel path.
  const ball = add(
    b.props.ball,
    160,
    "-108.882+505.182*time-46.591*time*time",
    "131.239+108.532*time+47.043*time*time",
    "33-11*time",
    3.6,
  );
  ball.timeRemap = track([
    [0, 1.3],
    [1, 1.8],
    [2.2, 2.4],
    [3.6, 2.7],
  ]);
  const ring = add(
    b.props.ring,
    188,
    "21.129+212.714*time-12.5*time*time",
    "-513.513+183.745*time+82.359*time*time-11.308*pow(time,3)-250*pow(max(0,1.6-time),2)",
    "67-16.5*time",
    5.4,
  );
  for (const axis of ["scale.0", "scale.1"])
    animate(ring, axis, [
      [0, 205],
      [1.8, 200],
      [2.4, 189],
      [3, 184],
      [4.4, 188],
    ]);

  const u = "(time-3.9)";
  const advance = "max(0,time-7.4)";
  const perspective = `(0.8/(1-0.32*${advance}))`;
  const girl = add(
    b.characters.girls.stand,
    80,
    `35+145*${u}+22*pow(${advance},2)+100*(${perspective}-0.8)`,
    `127+120*${u}+60*pow(${advance},2)+249*(${perspective}-0.8)`,
    `-22+4*sin(${u}*1.5)`,
  );
  girl.expressions["scale.0"] = `${perspective}*100`;
  girl.expressions["scale.1"] = `${perspective}*100`;
  add(
    b.characters.frog,
    61,
    `529.104+186.376*${u}-17.092*pow(${u},2)+4.329*pow(${u},3)`,
    `193.141+221.897*${u}-42.725*pow(${u},2)+7.467*pow(${u},3)`,
    `6+7*${u}`,
  );
  add(b.props.crown, 61, `-395+170*${u}`, `165+50*${u}`, `30+48*(${u}-3.5)`);

  // All shadows sample the same source time, trajectories and poses as their owners.
  const shadows = objects.map((item) => {
    const copy = structuredClone(item);
    copy.id = id("layer");
    copy.name = `${item.name} · cast shadow`;
    copy.expressions["position.0"] += "+55";
    copy.expressions["position.1"] += "+85";
    return copy;
  });
  c.layers = [];
  b.group(c, "Pool · shared cast shadows", shadows, P.shadow);
  c.layers.push(...objects);

  const medallion = comp("Crown · closing pool medallion", 200, 200, 0.4);
  b.circle(medallion, 100, 100, 200, P.cream);
  b.tint(b.add(medallion, b.props.crown, 100, 100, 60), P.green);
  const seal = during(b.add(c, medallion, 634, 440, 65), 0, 0.366666667);
  for (const axis of ["scale.0", "scale.1"])
    animate(seal, axis, [
      [0, 65, [0.45, 0, 0.7, 0.55]],
      [0.366666667, 0],
    ]);
  b.supporting.push(c, medallion);
  return c;
}
