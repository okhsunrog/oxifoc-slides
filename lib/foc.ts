import init, { FocSim, sampleFields } from "../wasm/pkg/oxifoc_sim.js";

export { FocSim };

export const FOC_HZ = 20_000;

/** Field order of `sim::Sample::write` in wasm/src/sim.rs. */
const KEYS = [
  "time",
  "mechAngle",
  "elecAngle",
  "estAngle",
  "rpm",
  "targetRpm",
  "ia",
  "ib",
  "ic",
  "id",
  "iq",
  "torque",
  "vAlpha",
  "vBeta",
  "dutyA",
  "dutyB",
  "dutyC",
  "starting",
] as const;

export type Sample = Record<(typeof KEYS)[number], number>;

let ready: Promise<unknown> | undefined;

export async function createSim(sensorless: boolean): Promise<FocSim> {
  ready ??= init();
  await ready;
  if (sampleFields() !== KEYS.length) {
    throw new Error(`wasm sample layout mismatch: ${sampleFields()} != ${KEYS.length}`);
  }
  return new FocSim(sensorless);
}

/** Append the samples packed in `buf` to `out`; returns the last one. */
export function unpack(buf: Float64Array, out: Sample[]): Sample | undefined {
  let last: Sample | undefined;
  for (let base = 0; base + KEYS.length <= buf.length; base += KEYS.length) {
    const sample = {} as Sample;
    KEYS.forEach((key, i) => {
      sample[key] = buf[base + i]!;
    });
    out.push(sample);
    last = sample;
  }
  return last;
}
