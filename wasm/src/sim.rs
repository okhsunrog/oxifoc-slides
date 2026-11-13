//! The firmware control stack in a closed loop with the virtual plant.
//!
//! `FocDriver` is the same type used in the f405 ISR; it is built
//! through the same config path (`RuntimeConfig` → `from_runtime_config`).
//! The PWM sink records duties and the current sensor returns the plant's
//! phase currents.

use core::f32::consts::{PI, TAU};
use core::f64::consts::TAU as TAU64;

use oxifoc_core::foc::controller::{FocController, FocOutput};
use oxifoc_core::foc::hall_sensor::HallSensor;
use oxifoc_core::foc::phase::{PhaseManager, PhaseProvider, PhaseSource};
use oxifoc_core::foc::pwm::{PhasePwm, PhaseState, SvpwmModulator};
use oxifoc_core::foc::sensors::CurrentSensor;
use oxifoc_core::foc::trig::LibmSinCos;
use oxifoc_core::foc::velocity::VelocityLoopConfig;
use oxifoc_core::motor::failsafe::BRAKE_ENTRY_MAX_E_RAD_S;
use oxifoc_core::motor::foc_driver::{CurrentLimits, DEFAULT_ACTUATION_DELAY_CYCLES};
use oxifoc_core::motor::{ControlMode, FocDriver};
use oxifoc_core::storage::{MotorParamsConfig, RuntimeConfig};
use oxifoc_core::virtual_motor::{MotorParams, VirtualMotor, VirtualMotorOutput};

pub const FOC_HZ: u32 = 15_000;
pub const DT: f32 = 1.0 / FOC_HZ as f32;
/// Driver/hall timebase: microseconds, like the firmware's tick counter.
const TICKS_PER_SECOND: u64 = 1_000_000;
const MAX_DUTY: u16 = 1000;

pub const VBUS: f32 = 24.0;
pub const MAX_CURRENT_A: f32 = 30.0;

/// Flipsky 5065 270KV, Y-equivalent per-phase values: R and L from the
/// line-to-line LCR measurement (0.071 Ω / 44 µH, halved), λ from the KV
/// rating: λ = 60 / (√3 · 2π · KV · pp) ≈ 2.9 mWb.
pub fn flipsky_5065() -> MotorParams {
    MotorParams {
        r: 0.036,
        ld: 22e-6,
        lq: 22e-6,
        lambda: 60.0 / (3f32.sqrt() * TAU * 270.0 * 7.0),
        pole_pairs: 7,
        // Bell + shaft plus a little external load inertia.
        j: 4e-4,
        friction_b: 2e-5,
        // Like the f405's center-aligned timer: the duties computed from a
        // current sample act from half a period after it. `Sim::new` gives
        // the driver the same delay — its compensations exist for exactly
        // this one.
        actuation_delay: DEFAULT_ACTUATION_DELAY_CYCLES,
        // The rotor keeps moving within a PWM period (zero-order hold).
        substeps: 4,
        ..MotorParams::default()
    }
}

/// Which estimate commutates the motor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AngleSource {
    Hall,
    Sensorless,
}

/// PWM sink with the boards' channel gating: `disable()` and an all-Float
/// topology turn the bridge off — the plant then coasts, where zero volts
/// would be all windings shorted, a brake — and only `enable()` or a driven
/// topology turns it back on.
struct SimPwm {
    duties: [u16; 3],
    enabled: bool,
}

impl PhasePwm for SimPwm {
    fn max_duty(&self) -> u16 {
        MAX_DUTY
    }
    fn set_duties(&mut self, duties: [u16; 3]) {
        self.duties = duties;
    }
    fn disable(&mut self) {
        self.enabled = false;
    }
    fn enable(&mut self) {
        self.enabled = true;
    }
    fn set_phase_states(&mut self, states: [PhaseState; 3]) {
        self.enabled = !states.iter().all(|s| matches!(s, PhaseState::Float));
        self.duties = states.map(|state| match state {
            PhaseState::Pwm(duty) => duty,
            PhaseState::Low | PhaseState::Float => 0,
        });
    }
}

struct PlantCurrents {
    currents: (f32, f32, f32),
}

impl CurrentSensor for PlantCurrents {
    fn read_currents(&self) -> (f32, f32, f32) {
        self.currents
    }
    fn read_raw(&self) -> (u16, u16, u16) {
        (0, 0, 0)
    }
    fn is_calibrated(&self) -> bool {
        true
    }
    fn get_offsets(&self) -> (f32, f32, f32) {
        (0.0, 0.0, 0.0)
    }
    fn set_offsets(&mut self, _offsets: (f32, f32, f32)) {}
}

type Driver = FocDriver<SimPwm, PlantCurrents, PhaseManager<HallSensor>, LibmSinCos>;

/// One decimated observation of the loop.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sample {
    /// Model time (s). f64 keeps individual FOC periods distinct during long runs.
    pub time: f64,
    /// Mechanical rotor angle (rad, wrapped to 0..2π) — drives the 3D model.
    pub mech_angle: f64,
    /// True electrical angle at the driver step (rad, wrapped).
    pub elec_angle: f32,
    /// The angle the controller commutates with (rad, wrapped).
    pub est_angle: f32,
    pub rpm: f32,
    pub target_rpm: f32,
    pub target_iq: f32,
    pub ia: f32,
    pub ib: f32,
    pub ic: f32,
    pub id: f32,
    pub iq: f32,
    pub torque: f32,
    pub v_alpha: f32,
    pub v_beta: f32,
    pub duty_a: f32,
    pub duty_b: f32,
    pub duty_c: f32,
    /// 1 while the sensorless cold-start sequencer owns the angle.
    pub starting: f32,
}

impl Sample {
    pub const FIELDS: usize = 19;

    pub fn write(&self, out: &mut Vec<f64>) {
        out.push(self.time);
        out.push(self.mech_angle);
        out.extend(
            [
                self.elec_angle,
                self.est_angle,
                self.rpm,
                self.target_rpm,
                self.ia,
                self.ib,
                self.ic,
                self.id,
                self.iq,
                self.torque,
                self.v_alpha,
                self.v_beta,
                self.duty_a,
                self.duty_b,
                self.duty_c,
                self.starting,
                self.target_iq,
            ]
            .map(f64::from),
        );
    }
}

pub struct Sim {
    params: MotorParams,
    motor: VirtualMotor,
    out: VirtualMotorOutput,
    driver: Driver,
    foc: FocOutput,
    last_hall: u8,
    /// Plant electrical angle before the last `motor.step` (hall edge timing).
    angle_before_step: f32,
    /// Plant state the driver saw on the last step (forensics).
    plant_at_driver: VirtualMotorOutput,
    step: u64,
    mech_angle: f64,
    target_rpm: f32,
    load_nm: f32,
    source: AngleSource,
}

impl Sim {
    pub fn new(params: MotorParams, source: AngleSource) -> Self {
        let config = RuntimeConfig {
            motor_params: Some(MotorParamsConfig {
                resistance_ohm: params.r,
                inductance_d_h: params.ld,
                inductance_q_h: params.lq,
                flux_linkage_wb: params.lambda,
                pole_pairs: params.pole_pairs,
                ..MotorParamsConfig::default()
            }),
            ..RuntimeConfig::default()
        };

        let mut motor = VirtualMotor::new(params);
        let out = motor.step(0.0, 0.0, 0.0, DT);

        let mut hall = HallSensor::new(1_000_000);
        hall.update(out.hall_state, 0);
        let mut phase = PhaseManager::with_hall(hall);
        phase.configure_observers_from_config(&config, VBUS);
        // f405 boot: commutation tracker on the observer angle.
        phase.set_phase_tracker(100.0, 1.2);

        let foc = FocController::<SvpwmModulator, LibmSinCos>::from_runtime_config(&config, VBUS);
        let mut driver = FocDriver::new(
            foc,
            SimPwm {
                duties: [0; 3],
                enabled: false,
            },
            PlantCurrents {
                currents: (0.0, 0.0, 0.0),
            },
            phase,
            DT,
        );
        driver.set_current_limits(CurrentLimits::from_max_current(MAX_CURRENT_A));
        driver.set_velocity_config(VelocityLoopConfig::default());
        driver.set_actuation_delay(params.actuation_delay);

        let mut sim = Self {
            params,
            motor,
            out,
            driver,
            foc: FocOutput::default(),
            last_hall: out.hall_state,
            angle_before_step: out.angle_rad,
            plant_at_driver: out,
            step: 0,
            mech_angle: 0.0,
            target_rpm: 0.0,
            load_nm: 0.0,
            source,
        };
        sim.apply_source();
        sim
    }

    fn apply_source(&mut self) {
        let source = match self.source {
            AngleSource::Hall => PhaseSource::Hall,
            AngleSource::Sensorless => PhaseSource::Observer,
        };
        // Both are configured in `new`, so the switch cannot be rejected.
        self.driver
            .phase_mut()
            .set_source(source)
            .expect("angle source configured");
    }

    pub fn set_source(&mut self, source: AngleSource) {
        if source != self.source {
            self.source = source;
            self.apply_source();
        }
    }

    pub fn source(&self) -> AngleSource {
        self.source
    }

    /// Mechanical RPM setpoint for the firmware velocity loop.
    ///
    /// 0 parks, the way the firmware's command gate treats a `Brake`: at
    /// speed a controlled stop that ends in the parking brake, near
    /// standstill the parking brake itself. (`Stopped` floats the bridge —
    /// this rotor would coast for tens of seconds.)
    pub fn set_target_rpm(&mut self, rpm: f32) {
        self.target_rpm = rpm;
        if rpm != 0.0 {
            self.driver.set_mode(ControlMode::VelocityControl {
                target_vel: rpm * TAU / 60.0 * f32::from(self.params.pole_pairs),
            });
        } else if self.driver.phase().get().velocity.abs() <= BRAKE_ENTRY_MAX_E_RAD_S
            || !self.driver.enter_brake_ramp()
        {
            self.driver.set_mode(ControlMode::Brake);
        }
    }

    /// Magnitude of the shaft load (N·m); it always opposes rotation.
    pub fn set_load(&mut self, load_nm: f32) {
        self.load_nm = load_nm.max(0.0);
    }

    pub fn set_target_iq(&mut self, amps: f32) {
        self.target_rpm = f32::NAN;
        self.driver.set_mode(ControlMode::CurrentControl {
            iq_target: amps,
            id_target: 0.0,
        });
    }

    fn now(&self) -> u64 {
        // Convert the absolute step so fractional microseconds do not accumulate drift.
        self.step * TICKS_PER_SECOND / u64::from(FOC_HZ)
    }

    pub(crate) fn step_count(&self) -> u64 {
        self.step
    }

    /// Timestamp (µs) of the hall edge the last plant step crossed.
    ///
    /// The f405 latches Hall edges with a 1 µs capture timer. Locate the
    /// crossing inside the FOC period to limit the velocity quantization:
    /// Hall boundaries sit at π/6 + k·π/3 (+ `hall_offset`) electrical.
    fn hall_edge_ticks(&self) -> u64 {
        const SECTOR: f32 = PI / 3.0;
        let offset = PI / 6.0 + self.params.hall_offset;
        let a0 = self.angle_before_step;
        let a1 = a0 + wrap(self.out.angle_rad - a0);
        let k0 = ((a0 - offset) / SECTOR).floor();
        let k1 = ((a1 - offset) / SECTOR).floor();
        let boundary = offset + SECTOR * k0.max(k1);
        if k0 == k1 || a1 == a0 {
            return self.now();
        }
        let frac = ((boundary - a0) / (a1 - a0)).clamp(0.0, 1.0);
        let ticks = (self.step - 1) * TICKS_PER_SECOND;
        let hz = u64::from(FOC_HZ);
        let offset_ticks =
            ((ticks % hz) as f64 + f64::from(frac) * TICKS_PER_SECOND as f64) / f64::from(FOC_HZ);
        ticks / hz + offset_ticks as u64
    }

    /// Advance one FOC period.
    pub fn step(&mut self) {
        self.step += 1;
        let now = self.now();
        if self.out.hall_state != self.last_hall {
            let edge = self.hall_edge_ticks();
            self.driver
                .phase_mut()
                .hall_mut()
                .update(self.out.hall_state, edge);
            self.last_hall = self.out.hall_state;
        }
        self.angle_before_step = self.out.angle_rad;
        self.plant_at_driver = self.out;
        self.driver.current_sensor_mut().currents = (self.out.ia, self.out.ib, self.out.ic);
        // On an error the driver latched Stopped and killed the PWM itself.
        self.foc = self.driver.step(now).unwrap_or_default();
        let omega_m = self.out.omega_e / f32::from(self.params.pole_pairs);
        // Smooth Coulomb load: opposes motion, no chatter through zero.
        let load = if self.load_nm == 0.0 {
            0.0
        } else {
            self.load_nm * (omega_m / 2.0).tanh()
        };
        self.out = if self.driver.pwm().enabled {
            self.motor.step(self.foc.v_alpha, self.foc.v_beta, load, DT)
        } else {
            self.motor.step_coast(load, DT)
        };
        self.mech_angle = (self.mech_angle + f64::from(omega_m * DT)).rem_euclid(TAU64);
    }

    /// The plant state the driver sampled on the last step, and what the
    /// driver computed from it (forensics).
    pub fn last_step(&self) -> (&VirtualMotorOutput, &FocOutput) {
        (&self.plant_at_driver, &self.foc)
    }

    /// The back-EMF observer's own angle (before the commutation tracker),
    /// for estimator forensics.
    pub fn observer_angle(&self) -> Option<f32> {
        self.driver.phase().observer().phase()
    }

    /// The observer's raw flux-vector angle from its last update (pre-PLL).
    pub fn observer_raw_angle(&self) -> Option<f32> {
        self.driver.phase().observer().phase_raw()
    }

    pub fn sample(&self) -> Sample {
        let pp = f32::from(self.params.pole_pairs);
        let duties = self.driver.pwm().duties;
        let duty = |d: u16| f32::from(d) / f32::from(MAX_DUTY);
        Sample {
            time: self.step as f64 / f64::from(FOC_HZ),
            mech_angle: self.mech_angle,
            // The rotor angle when the driver ran — what θ̂ estimates.
            elec_angle: wrap(self.angle_before_step),
            // The angle the driver actually commutated with this step.
            est_angle: wrap(self.foc.angle_rad),
            rpm: self.out.omega_e / pp * 60.0 / TAU,
            target_rpm: self.target_rpm,
            target_iq: match self.driver.mode() {
                ControlMode::CurrentControl { iq_target, .. } => iq_target,
                _ => f32::NAN,
            },
            ia: self.out.ia,
            ib: self.out.ib,
            ic: self.out.ic,
            id: self.foc.id,
            iq: self.foc.iq,
            torque: self.out.torque,
            v_alpha: self.foc.v_alpha,
            v_beta: self.foc.v_beta,
            duty_a: duty(duties[0]),
            duty_b: duty(duties[1]),
            duty_c: duty(duties[2]),
            starting: if self.driver.phase().is_starting() {
                1.0
            } else {
                0.0
            },
        }
    }
}

fn wrap(angle: f32) -> f32 {
    let a = angle % TAU;
    if a > PI {
        a - TAU
    } else if a <= -PI {
        a + TAU
    } else {
        a
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(sim: &mut Sim, seconds: f32) {
        for _ in 0..(seconds * FOC_HZ as f32) as u32 {
            sim.step();
        }
    }

    fn angle_error(s: &Sample) -> f32 {
        wrap(s.est_angle - s.elec_angle).abs()
    }

    #[test]
    fn microsecond_clock_matches_model_time() {
        let mut sim = Sim::new(flipsky_5065(), AngleSource::Hall);
        sim.step = u64::from(FOC_HZ) / 2;
        assert_eq!(sim.now(), 500_000);
        sim.step = u64::from(FOC_HZ);
        assert_eq!(sim.now(), TICKS_PER_SECOND);
        assert_eq!(sim.sample().time, 1.0);
    }

    #[test]
    fn hall_velocity_tracks_target() {
        let mut sim = Sim::new(flipsky_5065(), AngleSource::Hall);
        sim.set_target_rpm(1500.0);
        run(&mut sim, 3.0);
        let s = sim.sample();
        assert!((s.rpm - 1500.0).abs() < 75.0, "rpm {}", s.rpm);
    }

    #[test]
    fn hall_velocity_holds_under_load() {
        let mut sim = Sim::new(flipsky_5065(), AngleSource::Hall);
        sim.set_target_rpm(1500.0);
        sim.set_load(0.3);
        run(&mut sim, 4.0);
        let s = sim.sample();
        assert!((s.rpm - 1500.0).abs() < 75.0, "rpm {}", s.rpm);
        assert!(s.iq > 5.0, "iq {}", s.iq);
    }

    #[test]
    fn sensorless_cold_start_locks() {
        let mut sim = Sim::new(flipsky_5065(), AngleSource::Sensorless);
        sim.set_target_rpm(1500.0);
        run(&mut sim, 4.0);
        let s = sim.sample();
        assert_eq!(s.starting, 0.0, "still in cold start");
        assert!((s.rpm - 1500.0).abs() < 75.0, "rpm {}", s.rpm);
        assert!(angle_error(&s) < 0.25, "angle err {}", angle_error(&s));
    }

    #[test]
    fn current_control_tracks_positive_and_negative_iq() {
        let mut sim = Sim::new(flipsky_5065(), AngleSource::Hall);
        sim.set_target_rpm(700.0);
        run(&mut sim, 3.0);
        sim.set_load(0.05);

        sim.set_target_iq(5.0);
        run(&mut sim, 0.3);
        let accelerating = sim.sample();
        assert_eq!(accelerating.target_iq, 5.0);
        assert!(accelerating.target_rpm.is_nan());
        assert!(
            (accelerating.iq - 5.0).abs() < 0.75,
            "Iq {}",
            accelerating.iq
        );

        sim.set_target_iq(-4.0);
        run(&mut sim, 0.1);
        let braking = sim.sample();
        assert!((braking.iq + 4.0).abs() < 0.75, "Iq {}", braking.iq);
        assert!(braking.rpm < accelerating.rpm);
    }

    /// Target 0 parks the rotor: a controlled stop (~1.4 s from 1500 rpm at
    /// the failsafe's deceleration bound), then the parking brake. A floated
    /// bridge would leave this rotor coasting near 1500 rpm.
    #[test]
    fn zero_target_parks() {
        for source in [AngleSource::Hall, AngleSource::Sensorless] {
            let mut sim = Sim::new(flipsky_5065(), source);
            sim.set_target_rpm(1500.0);
            run(&mut sim, 4.0);
            sim.set_target_rpm(0.0);
            run(&mut sim, 2.5);
            let s = sim.sample();
            assert!(s.rpm.abs() < 30.0, "{source:?}: rpm {}", s.rpm);
            assert_eq!(sim.driver.mode(), ControlMode::Brake, "{source:?}");
        }
    }

    #[test]
    fn hall_to_sensorless_switch_on_the_fly() {
        let mut sim = Sim::new(flipsky_5065(), AngleSource::Hall);
        sim.set_target_rpm(2000.0);
        run(&mut sim, 3.0);
        sim.set_source(AngleSource::Sensorless);
        run(&mut sim, 2.0);
        let s = sim.sample();
        assert!((s.rpm - 2000.0).abs() < 100.0, "rpm {}", s.rpm);
        assert!(angle_error(&s) < 0.25, "angle err {}", angle_error(&s));
    }
}
