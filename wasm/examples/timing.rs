//! Per-stage timing of the sensorless chain at the driver's sampling
//! instants, in PWM periods of rotor travel:
//! - raw:  observer flux angle after update N   vs plant θ(t_N)
//! - pll:  observer PLL phase after update N     vs plant θ(t_{N+1})
//! - park: Park angle used at step N              vs plant θ(t_N)
//!
//! `cargo run --release --example timing`.

use std::f32::consts::{PI, TAU};

use oxifoc_sim::sim::{AngleSource, FOC_HZ, Sim, flipsky_5065};

fn wrap(a: f32) -> f32 {
    let a = a.rem_euclid(TAU);
    if a > PI { a - TAU } else { a }
}

fn run(delay: f32, substeps: u32) -> (f32, f32, f32) {
    let mut params = flipsky_5065();
    params.actuation_delay = delay;
    params.substeps = substeps;
    let mut sim = Sim::new(params, AngleSource::Hall);
    sim.set_target_rpm(2000.0);
    for _ in 0..6 * FOC_HZ {
        sim.step();
    }
    sim.set_source(AngleSource::Sensorless);
    for _ in 0..FOC_HZ {
        sim.step();
    }
    let n = 4000;
    let (mut raw, mut pll, mut park, mut w) = (0.0, 0.0, 0.0, 0.0);
    let mut prev_pll: Option<f32> = None;
    for _ in 0..n {
        sim.step();
        let (plant, foc) = sim.last_step();
        let theta = plant.angle_rad;
        w += plant.omega_e;
        raw += wrap(sim.observer_raw_angle().unwrap() - theta);
        park += wrap(foc.angle_rad - theta);
        // The PLL phase from the PREVIOUS step claims to be θ(t_N).
        if let Some(p) = prev_pll {
            pll += wrap(p - theta);
        }
        prev_pll = sim.observer_angle();
    }
    let per = w / n as f32 / FOC_HZ as f32;
    let n = n as f32;
    (raw / n / per, pll / (n - 1.0) / per, park / n / per)
}

fn main() {
    println!("2000 rpm, no load. Errors in PWM periods of rotor travel.");
    println!("delay substeps    raw     pll    park");
    for delay in [0.0, 0.5, 1.0] {
        for substeps in [1, 4, 16] {
            let (raw, pll, park) = run(delay, substeps);
            println!("{delay:5.1} {substeps:8}  {raw:+6.2}  {pll:+6.2}  {park:+6.2}");
        }
    }
}
