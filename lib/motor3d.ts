import * as T from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { POLES, SLOTS, WINDING, toothAzimuth, toothFlux } from "./winding";

/**
 * Flipsky 5065 outrunner. The exterior follows the reference photos. The
 * cutaway illustrates the 12N14P layout in `winding.ts`.
 */

const TAU = Math.PI * 2;
/** Tooth glow colours: north face / south face. */
const NORTH = new T.Color(0xff5a36);
const SOUTH = new T.Color(0x3d8bff);
const MAGNET_NORTH = 0x9e493b;
const MAGNET_SOUTH = 0x315383;

const metal = (color: number, roughness = 0.3, metalness = 0.8) =>
  new T.MeshStandardMaterial({ color, roughness, metalness });

export interface MotorState {
  /** Mechanical rotor angle (rad). */
  angle: number;
  /** Phase currents (A). */
  currents: readonly [number, number, number];
  /** Camera azimuth (rad): the cut-away hides the magnets facing it. */
  cameraAzimuth: number;
  /** Tooth current (A) that renders at full glow. */
  glowFullScale?: number;
}

export type Motor = ReturnType<typeof createMotor>;

export function createMotor() {
  const root = new T.Group();
  const rotor = new T.Group();
  const bell = new T.Group();
  const stator = new T.Group();
  root.add(rotor, stator);
  rotor.add(bell);

  const black = metal(0x212932, 0.34, 0.66);
  const edge = metal(0x111820, 0.22);
  const steel = metal(0xaebbc7, 0.23, 0.92);
  const iron = metal(0x515a64, 0.49, 0.65);
  const laminatedIron = iron.clone();
  laminatedIron.bumpMap = createMachiningFinish(34);
  laminatedIron.bumpScale = 0.004;
  const brass = metal(0xb68a45, 0.28);
  const copper = metal(0xbc6639, 0.32, 0.65);
  const insulation = metal(0x775044, 0.62, 0.15);
  const matte = (color: number) => metal(color, 0.7, 0.1);
  const outlineParts: T.Mesh[] = [];

  function mesh(geometry: T.BufferGeometry, material: T.Material, parent: T.Object3D, y = 0) {
    const m = new T.Mesh(geometry, material);
    m.position.y = y;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  function cylinder(
    radius: number,
    length: number,
    material: T.Material,
    parent: T.Object3D,
    y: number,
  ) {
    return mesh(new T.CylinderGeometry(radius, radius, length, 64), material, parent, y);
  }
  /** Flat annulus of `height`, centred on `y`; optional 4 flange bores. */
  function ring(
    outer: number,
    inner: number,
    height: number,
    material: T.Material,
    parent: T.Object3D,
    y: number,
    mountingHoles = false,
  ) {
    const shape = new T.Shape();
    shape.absarc(0, 0, outer, 0, TAU, false);
    const hole = new T.Path();
    hole.absarc(0, 0, inner, 0, TAU, true);
    shape.holes.push(hole);
    if (mountingHoles) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        const bore = new T.Path();
        bore.absarc(Math.sin(a) * 0.72, Math.cos(a) * 0.72, 0.082, 0, TAU, true);
        shape.holes.push(bore);
      }
    }
    const geo = new T.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: true,
      bevelSize: 0.012,
      bevelThickness: 0.012,
      bevelSegments: 2,
      curveSegments: 32,
    });
    geo.rotateX(Math.PI / 2);
    return mesh(geo, material, parent, y + height / 2);
  }

  // ── Rotating bell ─────────────────────────────────────────────────────
  const can = black.clone();
  can.bumpMap = createMachiningFinish(64);
  can.bumpScale = 0.003;
  const shell = mesh(
    revolved([
      [0.977, -1.22],
      [1.012, -1.22],
      [1.025, -1.2],
      [1.025, 0.88],
      [1.018, 0.92],
      [1.003, 0.945],
      [0.977, 0.945],
      [0.977, -1.22],
    ]),
    can,
    bell,
  );
  const rearCover = mesh(
    revolved([
      [0, -1.36],
      [0.914, -1.36],
      [0.992, -1.343],
      [1.025, -1.305],
      [1.025, -1.235],
      [1.01, -1.22],
      [0.982, -1.215],
      [0.982, -1.16],
      [0, -1.16],
    ]),
    black,
    bell,
  );
  cylinder(0.31, 0.16, steel, bell, -1.12);
  ring(0.975, 0.88, 0.08, iron, bell, -1.13);
  const label = createLabel(bell);
  outlineParts.push(shell, rearCover);

  // ── Shaft and bearing ─────────────────────────────────────────────────
  // Outer race stays in the flange; inner race turns with the shaft.
  ring(0.344, 0.273, 0.065, steel, stator, 1.29);
  ring(0.277, 0.197, 0.026, edge, stator, 1.296);
  ring(0.211, 0.165, 0.045, steel, rotor, 1.31);
  const shaft = mesh(
    revolved([
      [0, -1.29],
      [0.158, -1.29],
      [0.174, -1.26],
      [0.174, 1.27],
      [0.165, 1.295],
      [0.165, 1.39],
      [0.174, 1.405],
      [0.174, 2.3],
      [0.159, 2.324],
      [0, 2.324],
    ]),
    steel,
    rotor,
  );
  ring(0.212, 0.167, 0.018, brass, rotor, 1.375);
  const clip = mesh(new T.TorusGeometry(0.19, 0.012, 6, 48, Math.PI * 1.8), steel, rotor, 1.397);
  clip.rotation.x = Math.PI / 2;
  const keyway = mesh(new T.BoxGeometry(0.065, 0.63, 0.012), edge, rotor, 1.83);
  keyway.position.z = 0.166;
  outlineParts.push(shaft, keyway);

  // ── Fixed flange, cable exit, leads ───────────────────────────────────
  outlineParts.push(ring(1.023, 0.35, 0.36, black, stator, 1.16, true));
  ring(0.355, 0.18, 0.12, iron, stator, 1.23);
  ring(1.014, 0.956, 0.027, edge, stator, 0.969);
  const grommet = cylinder(0.168, 0.34, matte(0x141b21), stator, 1.1);
  grommet.rotation.z = Math.PI / 2;
  grommet.scale.x = 0.65;
  grommet.position.x = 1.075;
  const leadColors = [0xdf7b39, 0x506f98, 0xc4c6c5];
  const cable = matte(0x1b2229);
  leadColors.forEach((color, i) => {
    const points = [
      new T.Vector3(1.18, 1.13, -0.14 + i * 0.14),
      new T.Vector3(1.58, 1.08, -0.14 + i * 0.14),
      new T.Vector3(2.06 + i * 0.07, 0.73, -0.06 + i * 0.19),
      new T.Vector3(2.56 + i * 0.08, 0.48, 0.12 + i * 0.22),
    ];
    const end = points[3]!;
    const lead = mesh(
      new T.TubeGeometry(new T.CatmullRomCurve3(points), 32, 0.046, 10, false),
      cable,
      stator,
    );
    if (i === 1) outlineParts.push(lead);
    const connector = cylinder(0.06, 0.24, metal(color, 0.7, 0), stator, 0);
    connector.position.copy(end);
    connector.rotation.z = Math.PI / 2;
    const bullet = cylinder(0.044, 0.13, brass, stator, 0);
    bullet.position.copy(end).x += 0.17;
    bullet.rotation.z = Math.PI / 2;
  });
  const sensorPath = new T.CatmullRomCurve3([
    new T.Vector3(1.17, 1.04, -0.23),
    new T.Vector3(1.65, 0.97, -0.32),
    new T.Vector3(2.05, 0.46, -0.32),
    new T.Vector3(2.37, 0.17, -0.22),
  ]);
  mesh(new T.TubeGeometry(sensorPath, 36, 0.028, 8, false), edge, stator);
  mesh(new T.BoxGeometry(0.15, 0.1, 0.22), metal(0xe1ddd3, 0.7, 0), stator).position.set(
    2.39,
    0.17,
    -0.22,
  );

  // ── Stator: laminations, slot insulation and 12 copper windings ──────
  ring(0.36, 0.18, 1.58, iron, stator, 0.05);
  for (const y of [-0.75, 0.85]) ring(0.42, 0.19, 0.035, insulation, stator, y);
  ring(0.29, 0.18, 0.2, black, stator, 0.96);
  const coilGeometry = createCoil();
  const coilMaterials = WINDING.map(() => copper.clone());
  const toothGeometry = createTooth();
  for (let k = 0; k < SLOTS; k++) {
    const tooth = new T.Group();
    tooth.rotation.y = toothAzimuth(k);
    stator.add(tooth);
    mesh(toothGeometry, laminatedIron, tooth);
    mesh(coilGeometry, coilMaterials[k]!, tooth);
  }

  // ── Rotor: 14 magnets, N at even indices (electrical 0 at θm = 0) ────
  const magnets: T.Mesh[] = [];
  const magnetShape = createMagnet();
  const magnetMaterials = [metal(MAGNET_NORTH, 0.38, 0.4), metal(MAGNET_SOUTH, 0.38, 0.4)];
  for (let i = 0; i < POLES; i++) {
    const a = (i / POLES) * TAU;
    const magnet = mesh(magnetShape, magnetMaterials[i % 2]!, bell);
    magnet.rotation.y = a;
    magnet.userData.azimuth = a;
    magnets.push(magnet);
  }

  const outlineMaterial = new T.LineBasicMaterial({ color: 0x70caff, toneMapped: false });
  const outlines = new Map<T.BufferGeometry, T.EdgesGeometry>();
  for (const mesh of [...outlineParts, ...magnets]) {
    const edges = outlines.get(mesh.geometry) ?? new T.EdgesGeometry(mesh.geometry, 18);
    outlines.set(mesh.geometry, edges);
    const lines = new T.LineSegments(edges, outlineMaterial);
    lines.layers.set(1);
    mesh.add(lines);
  }

  let open = false;
  return {
    root,
    rotor,
    stator,
    disposeOutlines() {
      for (const edges of outlines.values()) edges.dispose();
      outlineMaterial.dispose();
    },
    /** Cut-away view: hide the can, reveal the stator. */
    setOpen(value: boolean) {
      open = value;
      shell.visible = !value;
      label.visible = !value;
    },
    update({ angle, currents, cameraAzimuth, glowFullScale = 15 }: MotorState) {
      rotor.rotation.y = angle;
      for (const magnet of magnets) {
        // In the cut-away, drop the magnets between the camera and the stator.
        magnet.visible = !open || Math.cos(magnet.userData.azimuth + angle - cameraAzimuth) < 0.1;
      }
      toothFlux(currents).forEach((flux, k) => {
        const material = coilMaterials[k]!;
        material.emissive.copy(flux >= 0 ? NORTH : SOUTH);
        material.emissiveIntensity = open ? Math.min(Math.abs(flux) / glowFullScale, 1.2) : 0;
      });
    },
  };
}

/** Radial/axial profile in the motor's Y-up frame. */
function revolved(profile: ReadonlyArray<readonly [number, number]>) {
  return new T.LatheGeometry(
    profile.map(([radius, y]) => new T.Vector2(radius, y)),
    96,
  );
}

/** Periodic height map for machining marks and stacked steel sheets. */
function createMachiningFinish(bands: number) {
  const data = new Uint8Array(256);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(128 + 76 * Math.sin((i * TAU * bands) / data.length));
  }
  const texture = new T.DataTexture(data, 1, data.length, T.RedFormat);
  texture.wrapT = T.RepeatWrapping;
  texture.minFilter = T.LinearMipmapLinearFilter;
  texture.magFilter = T.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** One curved magnet with closed edges and a small bevel. */
function createMagnet() {
  const end = (TAU / POLES) * 0.4;
  const shape = new T.Shape();
  shape.absarc(0, 0, 0.968, Math.PI / 2 - end, Math.PI / 2 + end, false);
  shape.lineTo(-Math.sin(end) * 0.915, Math.cos(end) * 0.915);
  shape.absarc(0, 0, 0.915, Math.PI / 2 + end, Math.PI / 2 - end, true);
  shape.closePath();
  const geometry = new T.ExtrudeGeometry(shape, {
    depth: 1.88,
    bevelSize: 0.005,
    bevelThickness: 0.02,
    bevelSegments: 1,
    curveSegments: 5,
  });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0.76, 0);
  return geometry;
}

/** Stamp profile of a stator tooth, extruded along the shaft. */
function createTooth() {
  const shape = new T.Shape([
    new T.Vector2(-0.088, 0.3),
    new T.Vector2(0.088, 0.3),
    new T.Vector2(0.101, 0.765),
    new T.Vector2(0.118, 0.797),
    new T.Vector2(0.132, 0.853),
    new T.Vector2(0.111, 0.872),
    new T.Vector2(-0.111, 0.872),
    new T.Vector2(-0.132, 0.853),
    new T.Vector2(-0.118, 0.797),
    new T.Vector2(-0.101, 0.765),
  ]);
  const geometry = new T.ExtrudeGeometry(shape, {
    depth: 1.52,
    bevelSize: 0.009,
    bevelThickness: 0.009,
    bevelSegments: 1,
  });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0.81, 0);
  const positions = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < positions.count; i++) {
    uv.setXY(i, uv.getX(i), (positions.getY(i) + 0.71) / 1.52);
  }
  return geometry;
}

/** Eleven illustrated turns around a radial tooth, merged into one geometry. */
function createCoil() {
  const segments = 24;
  const turns: T.BufferGeometry[] = [];
  for (let j = 0; j < 11; j++) {
    const z = 0.39 + j * 0.037;
    const points: T.Vector3[] = [];
    for (let k = 0; k < segments; k++) {
      const b = (k / segments) * TAU;
      // Superellipse: a rounded rectangle hugging the tooth.
      const x = 0.154 * Math.sign(Math.cos(b)) * Math.abs(Math.cos(b)) ** 0.45;
      const y = 0.86 * Math.sign(Math.sin(b)) * Math.abs(Math.sin(b)) ** 0.45 + 0.05;
      points.push(new T.Vector3(x, y, z));
    }
    turns.push(new T.TubeGeometry(new T.CatmullRomCurve3(points, true), segments, 0.018, 5, true));
  }
  const coil = mergeGeometries(turns)!;
  for (const turn of turns) turn.dispose();
  return coil;
}

/** Curved "FLIPSKY 5065" print on the can, rendered to a canvas texture. */
function createLabel(bell: T.Object3D) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;
  // The print runs axially, from the shaft-side flange toward the closed end.
  ctx.translate(742, 0);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = "#e4dfca";
  ctx.textAlign = "center";
  ctx.font = "800 178px Arial";
  ctx.fillText("FLIPSKY", 512, 160);
  ctx.font = "85px Arial";
  ctx.fillText("5065 / 270KV", 512, 245);
  ctx.font = "34px Arial";
  ctx.fillText("E-BOARD MOTOR", 512, 315);
  ctx.font = "28px Arial";
  ctx.fillText("flipsky.net", 512, 405);
  ctx.strokeStyle = "#a5a89e";
  ctx.lineWidth = 3;
  ctx.strokeRect(40, 175, 944, 178);
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  const label = new T.Mesh(
    new T.CylinderGeometry(1.029, 1.029, 1.95, 48, 1, true, -0.29, 1.6),
    new T.MeshStandardMaterial({
      map: texture,
      transparent: true,
      roughness: 0.55,
      metalness: 0.1,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
  );
  label.position.y = -0.15;
  bell.add(label);
  return label;
}
