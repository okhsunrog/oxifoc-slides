//! Commutation forensics at the driver's own sampling instant: the Park
//! angle `FocDriver` used vs the plant rotor angle at that same instant, and
//! the TRUE dq currents (plant currents Park-transformed with the plant
//! angle, both sampled when the driver ran). With id_target = 0 a correct
//! loop holds true id ≈ 0. `cargo run --release --example lead`.

use std::f32::consts::{PI, TAU};

use oxifoc_sim::sim::{AngleSource, FOC_HZ, Sim, flipsky_5065};

fn wrap(a: f32) -> f32 {
    let a = a.rem_euclid(TAU);
    if a > PI { a - TAU } else { a }
}

struct Stats {
    frame_err_periods: f32,
    true_id: f32,
    true_iq: f32,
    meas_id: f32,
}

fn measure(delay: f32, substeps: u32, source: AngleSource, rpm: f32, load: f32) -> Stats {
    let mut params = flipsky_5065();
    params.actuation_delay = delay;
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
    let n = 4000;
    let (mut err, mut w, mut tid, mut tiq, mut mid) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for _ in 0..n {
        sim.step();
        let (plant, foc) = sim.last_step();
        err += wrap(foc.angle_rad - plant.angle_rad);
        w += plant.omega_e;
        let i_alpha = plant.ia;
        let i_beta = (plant.ia + 2.0 * plant.ib) / 3f32.sqrt();
        let (s, c) = plant.angle_rad.sin_cos();
        tid += c * i_alpha + s * i_beta;
        tiq += -s * i_alpha + c * i_beta;
        mid += foc.id;
    }
    let n = n as f32;
    Stats {
        frame_err_periods: (err / n) / (w / n / FOC_HZ as f32),
        true_id: tid / n,
        true_iq: tiq / n,
        meas_id: mid / n,
    }
}

fn main() {
    println!("load 0.3 N·m. frame = Park angle − rotor angle (PWM periods of travel)");
    println!("delay sub  source       rpm  frame   true id  true iq  meas id");
    for (delay, substeps) in [(0.0, 1), (0.5, 1), (0.5, 4), (1.0, 4)] {
        for (name, source) in [
            ("hall", AngleSource::Hall),
            ("sensorless", AngleSource::Sensorless),
        ] {
            for rpm in [1500.0, 3000.0] {
                let s = measure(delay, substeps, source, rpm, 0.3);
                println!(
                    "{delay:5.1} {substeps:3}  {name:10} {rpm:5.0} {:+6.2}  {:+7.2}  {:+7.2}  {:+7.2}",
                    s.frame_err_periods, s.true_id, s.true_iq, s.meas_id
                );
            }
        }
    }
}
