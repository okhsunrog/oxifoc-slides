import { describe, expect, it } from "vite-plus/test";

import { POLE_PAIRS, WINDING, toothAzimuth, toothFlux } from "./winding";

const TAU = Math.PI * 2;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe("12N14P winding", () => {
  it("puts every coil within 15° electrical of its phase axis", () => {
    WINDING.forEach(({ phase, polarity }, k) => {
      const toothElec = POLE_PAIRS * toothAzimuth(k);
      const axis = (phase * TAU) / 3 + (polarity < 0 ? Math.PI : 0);
      expect(Math.abs(wrap(toothElec - axis))).toBeLessThanOrEqual(Math.PI / 12 + 1e-9);
    });
  });

  it("has four coils per phase, balanced in polarity", () => {
    for (const phase of [0, 1, 2]) {
      const coils = WINDING.filter((c) => c.phase === phase);
      expect(coils).toHaveLength(4);
      expect(coils.reduce((sum, c) => sum + c.polarity, 0)).toBe(0);
    }
  });

  it("points the stator field at the current vector angle", () => {
    // Current vector at electrical γ, amplitude-invariant Clarke inverse.
    for (const gamma of [0, 1, 2.5, -2]) {
      const currents = [0, 1, 2].map((p) => Math.cos(gamma - (p * TAU) / 3)) as [
        number,
        number,
        number,
      ];
      const flux = toothFlux(currents);
      // Fundamental of the tooth flux pattern in the electrical frame.
      let re = 0;
      let im = 0;
      flux.forEach((f, k) => {
        const elec = POLE_PAIRS * toothAzimuth(k);
        re += f * Math.cos(elec);
        im += f * Math.sin(elec);
      });
      expect(Math.abs(wrap(Math.atan2(im, re) - gamma))).toBeLessThan(1e-6);
    }
  });
});
