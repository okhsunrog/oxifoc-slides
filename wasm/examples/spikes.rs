//! Step-by-step dump around steady-state current spikes (hall edges vs the
//! commutation estimate): `cargo run --release --example spikes [sensorless]`.

use std::env;
use std::f32::consts::{PI, TAU};

use oxifoc_sim::sim::{AngleSource, Sim, flipsky_5065};

fn wrap(a: f32) -> f32 {
    let a = a.rem_euclid(TAU);
    if a > PI { a - TAU } else { a }
}

fn main() {
    let sensorless = env::args().any(|a| a == "sensorless");
    let source = if sensorless {
        AngleSource::Sensorless
    } else {
        AngleSource::Hall
    };
    let mut sim = Sim::new(flipsky_5065(), source);
    sim.set_target_rpm(1500.0);
    for _ in 0..60_000 {
        sim.step();
    }
    let mut prev = sim.sample();
    for i in 0..400 {
        sim.step();
        let s = sim.sample();
        let est_step = wrap(s.est_angle - prev.est_angle);
        let sector = ((wrap(s.elec_angle) + PI / 6.0).rem_euclid(TAU) / (PI / 3.0)) as u32;
        println!(
            "{i:4} sector={sector} elec={:+.3} est_step={est_step:+.4} err={:+.4} id={:+.2} iq={:+.2}",
            s.elec_angle,
            wrap(s.est_angle - s.elec_angle),
            s.id,
            s.iq
        );
        prev = s;
    }
}
