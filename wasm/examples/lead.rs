//! Physical commutation check: with id_target = 0 the TRUE d-axis current
//! (plant currents Park-transformed with the plant's rotor angle) should be
//! ~0. Hall vs sensorless under load, across plant timing models:
//! `cargo run --release --example lead`.

use oxifoc_sim::sim::{AngleSource, FOC_HZ, Sim, flipsky_5065};

/// Mean true (id, iq) in steady state at `rpm` under `load` N·m.
fn true_dq(delay: u8, substeps: u32, source: AngleSource, rpm: f32, load: f32) -> (f32, f32) {
    let mut params = flipsky_5065();
    params.actuation_delay_steps = delay;
    params.substeps = substeps;
    let mut sim = Sim::new(params, AngleSource::Hall);
    sim.set_target_rpm(rpm);
    sim.set_load(load);
    for _ in 0..8 * FOC_HZ {
        sim.step();
    }
    sim.set_source(source);
    for _ in 0..FOC_HZ {
        sim.step();
    }
    let (mut id, mut iq) = (0.0, 0.0);
    let n = 4000;
    for _ in 0..n {
        sim.step();
        let s = sim.sample();
        let i_alpha = s.ia;
        let i_beta = (s.ia + 2.0 * s.ib) / 3f32.sqrt();
        let (sin, cos) = s.elec_angle.sin_cos();
        id += cos * i_alpha + sin * i_beta;
        iq += -sin * i_alpha + cos * i_beta;
    }
    (id / n as f32, iq / n as f32)
}

fn main() {
    println!("load 0.3 N·m; true (id, iq) in A — id should be ~0");
    println!("delay substeps  source       @1500 rpm         @3000 rpm");
    for (delay, substeps) in [(0, 1), (1, 4)] {
        for (name, source) in [("hall", AngleSource::Hall), ("sensorless", AngleSource::Sensorless)] {
            let a = true_dq(delay, substeps, source, 1500.0, 0.3);
            let b = true_dq(delay, substeps, source, 3000.0, 0.3);
            println!(
                "{delay:5} {substeps:8}  {name:10}  ({:+5.2}, {:+5.2})  ({:+5.2}, {:+5.2})",
                a.0, a.1, b.0, b.1
            );
        }
    }
}
