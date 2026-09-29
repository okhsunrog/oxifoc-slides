<script setup lang="ts">
import { useIsSlideActive } from "@slidev/client";
import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";

import { StripChart, renderScale } from "../lib/chart";
import { FOC_HZ, type FocSim, type Sample, createSim, unpack } from "../lib/foc";
import { createMotor } from "../lib/motor3d";

/** Wall-clock seconds the strip charts span, whatever the time scale. */
const CHART_WALL_S = 2.5;
/** Aim for about this many points per chart window. */
const CHART_POINTS = 800;

const active = useIsSlideActive();

const targetRpm = ref(1500);
const reverse = ref(false);
const load = ref(0);
const sensorless = ref(false);
const timeScale = ref(0.02);
const paused = ref(false);
const interior = ref(false);
const failed = ref("");

const now = ref<Sample>();
const history: Sample[] = [];

const viewport = useTemplateRef<HTMLDivElement>("viewport");
const phasesCanvas = useTemplateRef<HTMLCanvasElement>("phases");
const dqCanvas = useTemplateRef<HTMLCanvasElement>("dq");
const speedCanvas = useTemplateRef<HTMLCanvasElement>("speed");

let sim: FocSim | undefined;
let pendingSteps = 0;

function applyControls() {
  if (!sim) return;
  sim.setTargetRpm(reverse.value ? -targetRpm.value : targetRpm.value);
  sim.setLoad(load.value);
  sim.setSensorless(sensorless.value);
}
watch([targetRpm, reverse, load, sensorless], applyControls);

/** Restart from standstill; `settleSeconds` of model time run up front. */
async function reset(settleSeconds = 0) {
  sim?.free();
  sim = await createSim(sensorless.value);
  history.length = 0;
  pendingSteps = 0;
  applyControls();
  // `advance` runs at most one model second per call.
  for (let s = 0; s < settleSeconds; s++) sim.advance(FOC_HZ, FOC_HZ);
  now.value = undefined;
}

const deg = (rad: number) => (rad * 180) / Math.PI;
const wrap = (rad: number) => Math.atan2(Math.sin(rad), Math.cos(rad));
const angleError = computed(() =>
  now.value ? deg(wrap(now.value.estAngle - now.value.elecAngle)) : 0,
);
/** Unit-circle point for the dial (SVG y points down, so angles run CCW). */
const tip = (rad: number, r: number) => ({ x: 60 + r * Math.cos(rad), y: 60 - r * Math.sin(rad) });
const trueTip = computed(() => tip(now.value?.elecAngle ?? 0, 44));
const estTip = computed(() => tip(now.value?.estAngle ?? 0, 36));
const hallSectors = Array.from({ length: 6 }, (_, i) => tip((i * Math.PI) / 3 + Math.PI / 6, 50));

const fmt = (v: number | undefined, digits = 0) =>
  v === undefined ? "–" : (Math.abs(v) < 10 ** -digits / 2 ? 0 : v).toFixed(digits);

let cleanup = () => {};

onMounted(async () => {
  const host = viewport.value!;
  const charts = [
    new StripChart(
      phasesCanvas.value!,
      [
        { key: "ia", color: "#168b79" },
        { key: "ib", color: "#cd8136" },
        { key: "ic", color: "#7965bd" },
      ],
      2,
    ),
    new StripChart(
      dqCanvas.value!,
      [
        { key: "iq", color: "#168b79" },
        { key: "id", color: "#7965bd" },
      ],
      2,
    ),
    new StripChart(
      speedCanvas.value!,
      [
        { key: "targetRpm", color: "#9aa7b2", dashed: true },
        { key: "rpm", color: "#426a9c" },
      ],
      500,
    ),
  ];

  try {
    await reset(3);
  } catch (error) {
    console.error(error);
    failed.value = "Не удалось загрузить wasm-модуль";
    return;
  }

  let renderer: T.WebGLRenderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  } catch (error) {
    console.error(error);
    failed.value = "Нужен WebGL 2 — включите аппаратное ускорение";
    return;
  }
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.6;
  host.appendChild(renderer.domElement);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(33, 1, 0.1, 60);
  camera.position.set(5.6, 4.4, 9.2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.2, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.maxPolarAngle = Math.PI * 0.8;
  controls.update();

  const pmrem = new T.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.85;
  room.dispose();
  pmrem.dispose();
  scene.add(new T.HemisphereLight(0xe0edff, 0x647080, 2.1));
  const key = new T.DirectionalLight(0xffffff, 4);
  key.position.set(-3, 6, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 6, bottom: -5 });
  key.shadow.normalBias = 0.025;
  scene.add(key);
  const rim = new T.DirectionalLight(0xb8d2ff, 2);
  rim.position.set(4, 2, -3);
  scene.add(rim);

  const motor = createMotor();
  motor.root.rotation.z = -0.22;
  scene.add(motor.root);
  const ground = new T.Mesh(
    new T.PlaneGeometry(200, 200),
    new T.ShadowMaterial({ color: 0x556678, opacity: 0.16 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.85;
  ground.receiveShadow = true;
  scene.add(ground);

  const resize = () => {
    renderer.setPixelRatio(renderScale(host));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  // The slide's CSS scale changes without a layout resize (window resize,
  // presenter view) — re-check the render scale occasionally.
  const rescale = setInterval(resize, 1000);

  const stopWatch = watch(interior, (open) => motor.setOpen(open), { immediate: true });

  let previous = performance.now();
  const frame = (wallTime: number) => {
    // rAF timestamps can predate the performance.now() taken on slide enter.
    const wallDt = Math.min(Math.max((wallTime - previous) / 1000, 0), 0.05);
    previous = wallTime;
    const window = CHART_WALL_S * timeScale.value;
    if (sim && !paused.value) {
      pendingSteps += wallDt * timeScale.value * FOC_HZ;
      const steps = Math.floor(pendingSteps);
      pendingSteps -= steps;
      const decimate = Math.max(1, Math.round((window * FOC_HZ) / CHART_POINTS));
      const last = unpack(sim.advance(steps, decimate), history);
      if (last) now.value = last;
      else if (!now.value) unpack(sim.sample(), history);
      const cutoff = (now.value?.time ?? 0) - window * 1.05;
      let stale = 0;
      while (stale < history.length && history[stale]!.time < cutoff) stale++;
      history.splice(0, stale);
    }
    const s = now.value;
    if (s) {
      motor.update({
        angle: s.mechAngle,
        currents: [s.ia, s.ib, s.ic],
        cameraAzimuth: Math.atan2(camera.position.x, camera.position.z),
      });
      for (const chart of charts) chart.draw(history, s.time, window);
    }
    controls.update();
    renderer.render(scene, camera);
  };

  const stopActive = watch(
    active,
    (isActive) => {
      previous = performance.now();
      renderer.setAnimationLoop(isActive ? frame : null);
    },
    { immediate: true },
  );

  cleanup = () => {
    stopActive();
    stopWatch();
    clearInterval(rescale);
    observer.disconnect();
    renderer.setAnimationLoop(null);
    controls.dispose();
    scene.traverse((object) => {
      if (object instanceof T.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material instanceof T.MeshStandardMaterial) material.map?.dispose();
          material.dispose();
        }
      }
    });
    env.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
});

onBeforeUnmount(() => {
  cleanup();
  sim?.free();
  sim = undefined;
});
</script>

<template>
  <div class="lab">
    <header>
      <div class="title">
        <b>oxifoc</b> FocDriver → wasm32
        <span class="chip">20 kHz</span>
        <span class="chip">60 KB</span>
        <span class="chip">Flipsky 5065 · 24 V</span>
      </div>
      <div class="status" :class="{ warn: now?.starting }">
        <i />
        {{ now?.starting ? "cold start: open loop" : sensorless ? "observer locked" : "hall" }}
      </div>
    </header>

    <div class="stage">
      <div ref="viewport" class="viewport">
        <div v-if="failed" class="failed">{{ failed }}</div>
      </div>
      <div class="dial">
        <svg viewBox="0 0 120 120" aria-label="Электрический угол: ротор и оценка">
          <circle cx="60" cy="60" r="50" class="ring" />
          <line
            v-for="(p, i) in hallSectors"
            :key="i"
            x1="60"
            y1="60"
            :x2="p.x"
            :y2="p.y"
            class="sector"
          />
          <line x1="60" y1="60" :x2="trueTip.x" :y2="trueTip.y" class="true" />
          <line x1="60" y1="60" :x2="estTip.x" :y2="estTip.y" class="est" />
          <circle cx="60" cy="60" r="3" class="hub" />
        </svg>
        <div class="dial-legend">
          <span class="k-true">θ ротора</span>
          <span class="k-est">θ̂ {{ sensorless ? "observer" : "hall" }}</span>
          <span class="err">Δ {{ fmt(angleError, 1) }}°</span>
        </div>
      </div>
      <button class="view-toggle" :class="{ on: interior }" @click="interior = !interior">
        {{ interior ? "Корпус" : "Внутри" }}
      </button>

      <div class="signals">
        <section>
          <h3>
            Фазные токи <span class="key" style="--c: #168b79">A</span
            ><span class="key" style="--c: #cd8136">B</span
            ><span class="key" style="--c: #7965bd">C</span>
            <em>{{ fmt(now?.ia, 1) }} A</em>
          </h3>
          <canvas ref="phases" />
        </section>
        <section>
          <h3>
            dq <span class="key" style="--c: #168b79">Iq</span
            ><span class="key" style="--c: #7965bd">Id</span>
            <em>{{ fmt(now?.iq, 1) }} A</em>
          </h3>
          <canvas ref="dq" />
        </section>
        <section>
          <h3>
            Скорость <span class="key" style="--c: #426a9c">факт</span
            ><span class="key dashed" style="--c: #9aa7b2">задание</span>
            <em>{{ fmt(now?.rpm) }} rpm</em>
          </h3>
          <canvas ref="speed" />
        </section>
        <p class="window">окно {{ fmt(CHART_WALL_S * timeScale * 1000) }} мс модельного времени</p>
      </div>
    </div>

    <footer>
      <button class="icon" :aria-label="paused ? 'Продолжить' : 'Пауза'" @click="paused = !paused">
        {{ paused ? "▶" : "❚❚" }}
      </button>
      <label class="slider">
        <span
          >Задание <output>{{ reverse ? -targetRpm : targetRpm }} rpm</output></span
        >
        <input v-model.number="targetRpm" type="range" min="0" max="4000" step="50" />
      </label>
      <button :class="{ on: reverse }" @click="reverse = !reverse">↔ реверс</button>
      <label class="slider">
        <span
          >Нагрузка <output>{{ load.toFixed(2) }} Н·м</output></span
        >
        <input v-model.number="load" type="range" min="0" max="0.6" step="0.02" />
      </label>
      <div class="segmented">
        <button :class="{ on: !sensorless }" @click="sensorless = false">Hall</button>
        <button :class="{ on: sensorless }" @click="sensorless = true">Sensorless</button>
      </div>
      <select v-model.number="timeScale" aria-label="Масштаб времени">
        <option :value="1">×1</option>
        <option :value="0.1">×0.1</option>
        <option :value="0.02">×0.02</option>
        <option :value="0.005">×0.005</option>
      </select>
      <button class="icon" aria-label="Сбросить" @click="reset()">↺</button>
    </footer>
  </div>
</template>

<style scoped>
.lab {
  --ink: #1d2730;
  --muted: #6d7b87;
  --line: #dde4ea;
  --panel: #f6f8fa;
  --accent: #e07b2c;
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 8px;
  padding: 14px 18px 12px;
  color: var(--ink);
  background: linear-gradient(180deg, #fbfcfd, #eef2f5);
  font-size: 12px;
  line-height: 1.2;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.title {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 15px;
}
.chip {
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 99px;
  color: var(--muted);
  font-size: 11px;
  font-family: ui-monospace, monospace;
}
.status {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--muted);
  font-family: ui-monospace, monospace;
}
.status i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #2aa876;
}
.status.warn i {
  background: var(--accent);
}
.stage {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 350px;
  gap: 10px;
  min-height: 0;
}
.viewport {
  position: relative;
  min-height: 0;
  border-radius: 10px;
  overflow: hidden;
}
.viewport :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}
.failed {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--muted);
}
.dial {
  position: absolute;
  left: 6px;
  bottom: 4px;
  display: flex;
  gap: 8px;
  align-items: center;
  pointer-events: none;
}
.dial svg {
  width: 112px;
  height: 112px;
}
.ring {
  fill: rgb(255 255 255 / 70%);
  stroke: var(--line);
  stroke-width: 1.5;
}
.sector {
  stroke: #e3e8ec;
  stroke-width: 1;
}
.true {
  stroke: var(--ink);
  stroke-width: 3.5;
  stroke-linecap: round;
}
.est {
  stroke: var(--accent);
  stroke-width: 3.5;
  stroke-linecap: round;
}
.hub {
  fill: var(--ink);
}
.dial-legend {
  display: grid;
  gap: 3px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
}
.k-true::before,
.k-est::before {
  content: "";
  display: inline-block;
  width: 12px;
  height: 3px;
  margin-right: 5px;
  vertical-align: middle;
  background: var(--ink);
}
.k-est::before {
  background: var(--accent);
}
.err {
  color: var(--muted);
}
.view-toggle {
  position: absolute;
  top: 4px;
  left: 6px;
}
.signals {
  display: grid;
  grid-template-rows: 1fr 1fr 1fr auto;
  gap: 6px;
  min-height: 0;
}
section {
  display: grid;
  grid-template-rows: auto 1fr;
  min-height: 0;
  padding: 6px 8px 4px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgb(255 255 255 / 80%);
}
h3 {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0 0 2px;
  font-size: 12px;
  font-weight: 600;
}
h3 em {
  margin-left: auto;
  font-style: normal;
  font-family: ui-monospace, monospace;
}
.key {
  color: var(--muted);
  font-weight: 400;
  font-size: 11px;
}
.key::before {
  content: "";
  display: inline-block;
  width: 10px;
  height: 2px;
  margin-right: 4px;
  vertical-align: middle;
  background: var(--c);
}
.key.dashed::before {
  background: repeating-linear-gradient(90deg, var(--c) 0 3px, transparent 3px 5px);
}
canvas {
  width: 100%;
  height: 100%;
  min-height: 0;
}
.window {
  margin: 0;
  color: var(--muted);
  text-align: right;
  font-size: 10px;
}
footer {
  display: flex;
  gap: 10px;
  align-items: center;
}
button,
select {
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: white;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
button.on {
  border-color: var(--ink);
  background: var(--ink);
  color: white;
}
button.icon {
  width: 32px;
  padding: 5px 0;
}
.slider {
  display: grid;
  flex: 1;
  gap: 2px;
  color: var(--muted);
}
.slider span {
  display: flex;
  justify-content: space-between;
}
.slider output {
  color: var(--ink);
  font-family: ui-monospace, monospace;
}
.slider input {
  width: 100%;
  accent-color: var(--ink);
}
.segmented {
  display: flex;
}
.segmented button:first-child {
  border-radius: 7px 0 0 7px;
}
.segmented button:last-child {
  border-left: 0;
  border-radius: 0 7px 7px 0;
}
</style>
