# oxifoc slides

Talk slides about [oxifoc](https://github.com/okhsunrog/oxifoc), built with
[Slidev](https://sli.dev) on top of [Vite+](https://viteplus.dev).

The live demo slide runs the actual firmware control stack in the browser:
`oxifoc-core`'s `FocDriver` (velocity loop, hall estimator, back-EMF
observer with sensorless cold start, SVPWM) closed-loop against its
`VirtualMotor` plant, compiled to `wasm32-unknown-unknown` (~60 KB). The
3D Flipsky 5065 model is driven straight from the simulation, and the
12N14P stator teeth glow with the flux of the simulated phase currents.

## Layout

- `slides.md` — the deck
- `components/MotorLab.vue` — the live demo slide
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

`wasm/Cargo.toml` pins `oxifoc-core` to a git revision; uncomment the
`[patch]` block there to develop against a local oxifoc checkout.
