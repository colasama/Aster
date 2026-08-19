import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileAdvancedDistortEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const point = (key: string, fallback = 50) => value(key, fallback) / 100;
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  const blend = () => value("blend", 100) / 100;
  switch (effect.type) {
    case "bezier-warp":
      emit(EffectOpcode.BezierWarp, [
        value("topBend"),
        value("bottomBend"),
        value("leftBend"),
        value("rightBend"),
        blend(),
      ]);
      return true;
    case "flo-motion":
      emit(EffectOpcode.FloMotion, [
        point("knot1X", 35),
        point("knot1Y"),
        value("amount1", 80),
        point("knot2X", 65),
        point("knot2Y"),
        value("amount2", -80),
        value("radius", 260),
        blend(),
      ]);
      return true;
    case "griddler":
      emit(EffectOpcode.Griddler, [
        value("tileWidth", 160),
        value("tileHeight", 160),
        degrees("rotation"),
        value("scale", 100) / 100,
        value("offsetX"),
        value("offsetY"),
        blend(),
      ]);
      return true;
    case "power-pin":
      emit(EffectOpcode.PowerPin, [
        point("upperLeftX", 0),
        point("upperLeftY", 0),
        point("upperRightX", 100),
        point("upperRightY", 0),
        point("lowerLeftX", 0),
        point("lowerLeftY", 100),
        point("lowerRightX", 100),
        point("lowerRightY", 100),
        value("perspective", 1),
        blend(),
      ]);
      return true;
    case "ripple-pulse":
      emit(EffectOpcode.RipplePulse, [
        point("centerX"),
        point("centerY"),
        value("radius", 280),
        value("waveWidth", 80),
        value("amplitude", 28),
        value("speed", 1),
        degrees("phase"),
        value("decay", 1.2),
        blend(),
      ]);
      return true;
    case "slant":
      emit(EffectOpcode.Slant, [degrees("slant", 24), point("floor"), value("axis"), blend()]);
      return true;
    case "smear":
      emit(EffectOpcode.Smear, [
        point("fromX", 35),
        point("fromY"),
        point("toX", 65),
        point("toY"),
        value("radius", 180),
        value("amount", 100) / 100,
        value("feather", 60),
        blend(),
      ]);
      return true;
    case "split":
      emit(EffectOpcode.Split, [
        point("centerX"),
        point("centerY"),
        degrees("angle"),
        value("distance", 80),
        value("feather", 12),
        blend(),
      ]);
      return true;
    default:
      return false;
  }
}
