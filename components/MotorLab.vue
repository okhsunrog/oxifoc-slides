<script setup lang="ts">
import * as T from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue";

import { StripChart, renderScale } from "../lib/chart";
import { FocSim, type Sample, initSim, unpack } from "../lib/foc";
import { createMotor } from "../lib/motor3d";

const CHART_WINDOW_S = 3.5;
const DEMO_TIME_SCALE = 0.35;
const BACKGROUND_TIME_SCALE = 0.035;
const COMMAND_TIMES = [0, 0.35, 1.5, 2.6, CHART_WINDOW_S];
const VELOCITY_RPM = [700, 1700, 1700, 700];
const VELOCITY_LOAD_NM = [0, 0, 0.2, 0];
const CURRENT_IQ = [2, 5, -4, 2];
const CURRENT_LOAD_NM = 0.05;
/** Aim for about this many points per chart window. */
const CHART_POINTS = 800;
const CHART_INTERVAL_MS = 1000 / 30;

const props = defineProps<{ demo: boolean; step: number; staticFrame: boolean }>();
const interior = computed(() => props.demo && props.step >= 1);
const showCharts = computed(() => props.demo && props.step >= 2);
const currentMode = computed(() => props.demo && props.step >= 3);
const stageTitle = computed(() =>
  currentMode.value ? "Current Control" : showCharts.value ? "Velocity Control" : "Flipsky 5065",
);
const failed = ref("");

const now = shallowRef<Sample>();
const focHz = ref(0);
const history: Sample[] = [];

const viewport = useTemplateRef<HTMLDivElement>("viewport");
const phasesCanvas = useTemplateRef<HTMLCanvasElement>("phases");
const dqCanvas = useTemplateRef<HTMLCanvasElement>("dq");
const speedCanvas = useTemplateRef<HTMLCanvasElement>("speed");

let disposed = false;

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
        { key: "targetIq", color: "#9aa7b2", dashed: true },
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
    focHz.value = await initSim();
  } catch (error) {
    console.error(error);
    failed.value = "Не удалось загрузить wasm-модуль";
    return;
  }
  if (disposed) return;

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
  const camera = new T.PerspectiveCamera(31, 1, 0.1, 60);
  camera.position.set(5.6, 4.4, 9.2);
  camera.lookAt(0, 0.1, 0);

  const pmrem = new T.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.85;
  room.dispose();
  pmrem.dispose();
  scene.add(new T.HemisphereLight(0xe0edff, 0x647080, 2.1));
  const key = new T.DirectionalLight(0xfff3e6, 3.5);
  key.position.set(-3.5, 6, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
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
    new T.ShadowMaterial({ color: 0x556678, opacity: 0.11 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.85;
  ground.receiveShadow = true;
  scene.add(ground);

  let renderedSize: [number, number, number] | undefined;
  let sceneDirty = true;
  let chartsDirty = true;
  const invalidateScene = () => {
    sceneDirty = true;
    chartsDirty = true;
  };
  renderer.domElement.addEventListener("webglcontextrestored", invalidateScene);
  const resize = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    const scale = renderScale(host);
    if (renderedSize?.[0] === width && renderedSize[1] === height && renderedSize[2] === scale)
      return;
    renderedSize = [width, height, scale];
    renderer.setDrawingBufferSize(width, height, scale);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    sceneDirty = true;
    chartsDirty = true;
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  // The slide's CSS scale changes without a layout resize (window resize,
  // presenter view) — re-check the render scale occasionally.
  const rescale = setInterval(resize, 1000);

  const sim = new FocSim(false);
  sim.setTargetRpm(700);
  for (let i = 0; i < 3; i++) sim.advance(focHz.value, focHz.value);
  now.value = unpack(sim.sample(), history);
  let pendingSteps = 0;
  let previous: number | undefined;
  let elapsedSteps = 0;
  let command = -1;
  let spread = 0;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const commandEnds = COMMAND_TIMES.slice(1).map((seconds) => Math.round(seconds * focHz.value));
  const decimate = Math.max(1, Math.round((CHART_WINDOW_S * focHz.value) / CHART_POINTS));

  function applyCommand() {
    const nextCommand = showCharts.value ? commandEnds.findIndex((end) => elapsedSteps < end) : 0;
    if (command === nextCommand) return;
    command = nextCommand;
    if (currentMode.value) {
      sim.setLoad(CURRENT_LOAD_NM);
      sim.setTargetIq(CURRENT_IQ[command]!);
    } else {
      sim.setLoad(VELOCITY_LOAD_NM[command]!);
      sim.setTargetRpm(VELOCITY_RPM[command]!);
    }
  }

  const demoSteps = commandEnds.at(-1)!;
  function advanceDemo(steps: number) {
    let remaining = Math.min(steps, demoSteps - elapsedSteps);
    while (remaining > 0) {
      applyCommand();
      const count = Math.min(remaining, focHz.value, commandEnds[command]! - elapsedSteps);
      now.value = unpack(sim.advance(count, decimate), history) ?? now.value;
      elapsedSteps += count;
      remaining -= count;
    }
  }

  const stopStage = watch(
    [() => props.demo, () => props.step],
    () => {
      const outline = !props.demo;
      camera.layers.set(outline ? 1 : 0);
      renderer.shadowMap.enabled = !outline;
      ground.visible = !outline;
      motor.setOpen(interior.value);
      elapsedSteps = 0;
      command = -1;
      history.length = 0;
      pendingSteps = 0;
      previous = undefined;
      applyCommand();
      now.value = unpack(sim.sample(), history);
      if (props.staticFrame && showCharts.value) advanceDemo(demoSteps);
      invalidateScene();
    },
    { immediate: true },
  );
  const resetClock = () => {
    previous = undefined;
  };
  document.addEventListener("visibilitychange", resetClock);

  let renderedSample: Sample | undefined;
  let chartSample: Sample | undefined;
  let renderedChartTick = -1;
  const frame = (wallTime: number) => {
    // Catch up through ordinary frame drops, but bound each WASM batch to one second.
    const wallDt = Math.min(Math.max((wallTime - (previous ?? wallTime)) / 1000, 0), 1);
    previous = wallTime;
    const timeScale = showCharts.value ? DEMO_TIME_SCALE : BACKGROUND_TIME_SCALE;
    const chartTick = Math.floor(wallTime / CHART_INTERVAL_MS);
    if (!props.staticFrame) pendingSteps += wallDt * timeScale * focHz.value;
    if (props.demo || chartTick !== renderedChartTick) {
      const steps = Math.min(focHz.value, Math.floor(pendingSteps));
      if (steps) {
        pendingSteps -= steps;
        if (showCharts.value) {
          advanceDemo(steps);
        } else {
          sim.advance(steps, steps + 1);
          history.length = 0;
          now.value = unpack(sim.sample(), history);
        }
      }
    }
    const s = now.value;
    const desiredSpread = interior.value ? 0.9 : 0;
    const nextSpread =
      reducedMotion.matches || props.staticFrame || Math.abs(desiredSpread - spread) < 0.002
        ? desiredSpread
        : T.MathUtils.lerp(spread, desiredSpread, 1 - Math.exp(-8 * wallDt));
    if (s && (sceneDirty || s !== renderedSample || nextSpread !== spread)) {
      spread = nextSpread;
      motor.rotor.position.y = -spread;
      ground.position.y = -1.65 - spread;
      motor.update({
        angle: s.mechAngle,
        currents: [s.ia, s.ib, s.ic],
        cameraAzimuth: Math.atan2(camera.position.x, camera.position.z),
      });
      renderer.render(scene, camera);
      sceneDirty = false;
    }
    if (
      showCharts.value &&
      s &&
      (chartsDirty || (s !== chartSample && chartTick !== renderedChartTick))
    ) {
      const windowEnd = history[0]!.time + CHART_WINDOW_S;
      for (const chart of charts) chart.draw(history, windowEnd, CHART_WINDOW_S);
      chartsDirty = false;
      chartSample = s;
    }
    renderedChartTick = chartTick;
    renderedSample = s;
  };

  renderer.setAnimationLoop(frame);

  cleanup = () => {
    stopStage();
    document.removeEventListener("visibilitychange", resetClock);
    clearInterval(rescale);
    observer.disconnect();
    renderer.setAnimationLoop(null);
    renderer.domElement.removeEventListener("webglcontextrestored", invalidateScene);
    scene.traverse((object) => {
      if (object instanceof T.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material instanceof T.MeshStandardMaterial) {
            material.map?.dispose();
            material.bumpMap?.dispose();
          }
          material.dispose();
        }
      }
    });
    motor.disposeOutlines();
    env.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    sim.free();
  };
});

onBeforeUnmount(() => {
  disposed = true;
  cleanup();
});
</script>

<template>
  <div class="lab" :class="{ demo, 'show-charts': showCharts }">
    <div ref="viewport" class="viewport" aria-hidden="true"></div>
    <header v-if="demo">
      <h1>{{ stageTitle }}</h1>
      <p v-if="showCharts">
        {{ currentMode ? "Задание тока Iq" : "Задание скорости и нагрузка на валу" }}
      </p>
      <p v-else>
        {{ interior ? "Статор, обмотки и ротор" : "12 зубцов статора · 14 полюсов ротора" }}
      </p>
    </header>

    <div v-if="demo && failed" class="failed">{{ failed }}</div>
    <div v-if="showCharts" class="dial">
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
        <span class="k-est">θ̂ Hall</span>
        <span class="err">Δ {{ fmt(angleError, 1) }}°</span>
      </div>
    </div>
    <div v-show="showCharts" class="signals">
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
          <span v-if="currentMode" class="key dashed">задание Iq</span>
          <em>{{ fmt(now?.iq, 1) }} A</em>
        </h3>
        <canvas ref="dq" />
      </section>
      <section>
        <h3>
          Скорость <span class="key" style="--c: #426a9c">факт</span
          ><span v-if="!currentMode" class="key dashed">задание</span>
          <em>{{ fmt(now?.rpm) }} rpm</em>
        </h3>
        <canvas ref="speed" />
      </section>
      <p class="window">{{ fmt(CHART_WINDOW_S, 1) }} с модельного времени</p>
    </div>
  </div>
</template>

<style scoped>
.lab {
  --ink: #152b40;
  --muted: #50697f;
  --line: #cbdbe8;
  --accent: #1569a1;
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  color: var(--ink);
  font-family: "Inter", system-ui, sans-serif;
  line-height: 1.2;
}
.lab::before {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 32% 45%, #fbfdff, #e9f1f8);
  opacity: 0;
  transition: opacity 500ms;
}
.lab.demo::before {
  opacity: 1;
}
header {
  position: absolute;
  top: 24px;
  left: 32px;
}
header h1 {
  margin: 0;
  font-size: 33px;
  font-weight: 650;
  letter-spacing: -0.04em;
}
header p {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 16px;
}
.viewport {
  position: absolute;
  top: 8%;
  left: 51%;
  width: 47%;
  height: 84%;
  opacity: 0.62;
  transition:
    left 620ms cubic-bezier(0.22, 1, 0.36, 1),
    top 620ms cubic-bezier(0.22, 1, 0.36, 1),
    width 620ms cubic-bezier(0.22, 1, 0.36, 1),
    height 620ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 480ms ease;
}
.demo .viewport {
  top: 13%;
  left: 7%;
  width: 86%;
  height: 84%;
  opacity: 1;
}
.show-charts .viewport {
  left: 2%;
  width: 61%;
}
@media (prefers-reduced-motion: reduce) {
  .lab::before,
  .viewport {
    transition: none;
  }
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
  left: 28px;
  bottom: 20px;
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
.signals {
  position: absolute;
  inset: 95px 28px 22px auto;
  width: 33%;
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
  min-height: 56px;
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
  min-width: 0;
  height: auto;
  gap: 6px;
  padding: 6px 10px;
  overflow: visible;
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
  appearance: none;
  display: block;
  width: 100%;
  height: 20px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.slider input::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: #aab7c2;
}
.slider input::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -6px;
  border: 2px solid white;
  border-radius: 50%;
  background: var(--ink);
  box-shadow: 0 0 0 1px var(--line);
}
.slider input::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: #aab7c2;
}
.slider input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 2px solid white;
  border-radius: 50%;
  background: var(--ink);
  box-shadow: 0 0 0 1px var(--line);
}
.slider input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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
