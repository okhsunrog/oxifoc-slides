//! wasm-bindgen surface over [`sim::Sim`].

pub mod sim;

use js_sys::Float64Array;
use wasm_bindgen::prelude::*;

use sim::{AngleSource, Sample, Sim, flipsky_5065};

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// Number of fields per sample in the buffers returned by `advance`.
#[wasm_bindgen(js_name = sampleFields)]
pub fn sample_fields() -> usize {
    Sample::FIELDS
}

#[wasm_bindgen(js_name = focHz)]
pub fn foc_hz() -> u32 {
    sim::FOC_HZ
}

#[wasm_bindgen]
pub struct FocSim {
    sim: Sim,
    buf: Vec<f64>,
}

#[wasm_bindgen]
impl FocSim {
    #[wasm_bindgen(constructor)]
    pub fn new(sensorless: bool) -> Self {
        Self {
            sim: Sim::new(flipsky_5065(), source(sensorless)),
            buf: Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = setTargetRpm)]
    pub fn set_target_rpm(&mut self, rpm: f32) {
        self.sim.set_target_rpm(rpm);
    }

    #[wasm_bindgen(js_name = setTargetIq)]
    pub fn set_target_iq(&mut self, amps: f32) {
        self.sim.set_target_iq(amps);
    }

    #[wasm_bindgen(js_name = setLoad)]
    pub fn set_load(&mut self, load_nm: f32) {
        self.sim.set_load(load_nm);
    }

    #[wasm_bindgen(js_name = setSensorless)]
    pub fn set_sensorless(&mut self, sensorless: bool) {
        self.sim.set_source(source(sensorless));
    }

    #[wasm_bindgen(getter)]
    pub fn sensorless(&self) -> bool {
        self.sim.source() == AngleSource::Sensorless
    }

    /// Run `steps` FOC periods (at most one model second per call), recording
    /// every `decimate`-th one on the simulation's step grid. Returns
    /// `Sample::FIELDS` values per sample.
    pub fn advance(&mut self, steps: u32, decimate: u32) -> Float64Array {
        let decimate = decimate.max(1);
        self.buf.clear();
        // A negative JS count arrives wrapped to ~4e9 — never trust it.
        let steps = steps.min(sim::FOC_HZ);
        let mut next_sample = decimate - (self.sim.step_count() % u64::from(decimate)) as u32;
        for step in 1..=steps {
            self.sim.step();
            if step == next_sample {
                self.sim.sample().write(&mut self.buf);
                next_sample = next_sample.saturating_add(decimate);
            }
        }
        Float64Array::from(self.buf.as_slice())
    }

    /// The current state as one sample.
    pub fn sample(&self) -> Float64Array {
        let mut buf = Vec::with_capacity(Sample::FIELDS);
        self.sim.sample().write(&mut buf);
        Float64Array::from(buf.as_slice())
    }
}

fn source(sensorless: bool) -> AngleSource {
    if sensorless {
        AngleSource::Sensorless
    } else {
        AngleSource::Hall
    }
}
