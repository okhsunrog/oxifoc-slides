import init, { FocSim, focHz, sampleFields } from "../wasm/pkg/oxifoc_sim.js";

export { FocSim };

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
  "targetIq",
] as const;

export type Sample = Record<(typeof KEYS)[number], number>;

let ready: ReturnType<typeof init> | undefined;

export async function initSim() {
  ready ??= init().catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  await ready;
  if (sampleFields() !== KEYS.length) {
    throw new Error(`wasm sample layout mismatch: ${sampleFields()} != ${KEYS.length}`);
  }
  return focHz();
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
