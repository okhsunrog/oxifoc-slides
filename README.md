# oxifoc slides

Talk slides about [oxifoc](https://github.com/okhsunrog/oxifoc), built with
[Slidev](https://sli.dev) on top of [Vite+](https://viteplus.dev).

The live demo slide runs the actual firmware control stack in the browser:
`oxifoc-core`'s `FocDriver` (velocity loop, Hall estimator, back-EMF observer
with sensorless cold start, SVPWM) closed-loop against its `VirtualMotor` plant,
compiled to `wasm32-unknown-unknown` (~92 KB). The
3D Flipsky 5065 model is driven straight from the simulation, and the
12N14P stator teeth glow with the flux of the simulated phase currents.

## Layout

- `slides.md` — the deck
- `global-top.vue` and `components/MotorLab.vue` — the motor shared across slides
- `lib/` — wasm wrapper, strip charts, 3D motor model, winding layout
- `wasm/` — Rust crate wrapping the closed loop (`sim.rs`) for wasm-bindgen;
  `examples/` hold the estimator forensics scripts used while building it

## Running

Needs Rust with the `wasm32-unknown-unknown` target and
[`wasm-pack`](https://github.com/wasm-bindgen/wasm-pack).

```sh
vp install
vp run dev      # builds the wasm pkg, then starts Slidev on :3030
vp run build    # static build into dist/
vp test         # winding layout tests
cargo test --release --manifest-path wasm/Cargo.toml   # closed-loop tests
```

For PDF export, install Chromium with `vpx playwright install chromium`, then run
`vp run export`.

Advance with the presentation remote or `PageDown`. The demo opens on the
assembled motor, then each click reveals the cutaway, runs a velocity-control
transient, or runs a current-control transient. The graphs hold the result
until the next click. The next slide returns the motor to the background.
The demo slide's `motor: demo` and `clicks: 3` are set in `slides.md`.

Slidev 53.1's Twoslash integration requires TypeScript 6.

`wasm/Cargo.toml` pins `oxifoc-core` to a git revision; uncomment the
`[patch]` block there to develop against a local oxifoc checkout.
