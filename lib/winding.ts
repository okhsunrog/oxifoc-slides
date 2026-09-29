/**
 * 12N14P concentrated winding — the Flipsky 5065 layout.
 *
 * Frames: azimuths are mechanical, measured the way three.js `rotation.y`
 * turns (atan2(x, z)); electrical position = pole_pairs × azimuth. Phase
 * axes are the standard A = 0°, B = 120°, C = 240° electrical — the frame the
 * firmware's Clarke/Park and the virtual plant use — so a rotor turned by
 * `rotation.y = θm` carries its magnet N axis at electrical 7·θm = φ, exactly
 * the plant's rotor angle.
 *
 * In this frame the textbook pattern reads "AacCBbaACcbB" (uppercase = wound
 * forward, lowercase = reversed). Coils pair up (Aa, cC, …) and a pair's
 * resultant axis lies midway between its two teeth, 15° electrical past the
 * first — so the stator is turned back by that much to put phase A's axis at
 * exactly 0°. Every coil then sits within 15° of its phase axis, and the
 * stator field points along the current vector (`winding.test.ts`).
 */
export const SLOTS = 12;
export const POLES = 14;
export const POLE_PAIRS = POLES / 2;

const PATTERN = "AacCBbaACcbB";

export interface Coil {
  /** 0 = A, 1 = B, 2 = C */
  phase: 0 | 1 | 2;
  /** +1 forward, −1 reversed */
  polarity: 1 | -1;
}

export const WINDING: readonly Coil[] = [...PATTERN].map((letter) => ({
  phase: "ABC".indexOf(letter.toUpperCase()) as Coil["phase"],
  polarity: letter === letter.toUpperCase() ? 1 : -1,
}));

/** Mechanical azimuth (rad) of tooth `k`. */
export function toothAzimuth(k: number) {
  return (k / SLOTS) * Math.PI * 2 - Math.PI / 12 / POLE_PAIRS;
}

/**
 * Flux each tooth pushes toward the rotor (+ = north face), in amps-turn
 * units of one coil, for the given phase currents.
 */
export function toothFlux(currents: readonly [number, number, number]): number[] {
  return WINDING.map(({ phase, polarity }) => polarity * currents[phase]);
}
