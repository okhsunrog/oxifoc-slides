//! Prints a decimated trajectory of the closed loop (sanity-check the
//! transients the slides will show): `cargo run --release --example trace [sensorless]`.

use std::env;

use oxifoc_sim::sim::{AngleSource, FOC_HZ, Sim, flipsky_5065};

fn main() {
    let sensorless = env::args().any(|a| a == "sensorless");
    let source = if sensorless {
        AngleSource::Sensorless
    } else {
        AngleSource::Hall
    };
    let mut sim = Sim::new(flipsky_5065(), source);
    sim.set_target_rpm(1500.0);
    println!("   t     rpm     iq     id   angle_err  starting");
    for i in 0..(9 * FOC_HZ) {
        if i == 3 * FOC_HZ {
            sim.set_load(0.3);
        }
        if i == 4 * FOC_HZ {
            sim.set_target_rpm(-800.0);
        }
        sim.step();
        if i % (FOC_HZ / 20) == 0 {
            let s = sim.sample();
            let mut err = (s.est_angle - s.elec_angle).rem_euclid(std::f32::consts::TAU);
            if err > std::f32::consts::PI {
                err -= std::f32::consts::TAU;
            }
            println!(
                "{:5.2} {:7.0} {:6.2} {:6.2} {:9.3} {:5.0}",
                s.time, s.rpm, s.iq, s.id, err, s.starting
            );
        }
    }
}
