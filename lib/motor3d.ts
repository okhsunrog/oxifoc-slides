import * as T from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { POLES, SLOTS, WINDING, toothAzimuth, toothFlux } from "./winding";

/**
 * Flipsky 5065 outrunner, modelled from photos: 50 × 65 mm can, rotating
 * bell + keyed shaft, fixed shaft-side flange with the cable exit. The
 * interior is the real 12N14P layout (see `winding.ts`), so the rotor and
 * the tooth glow can be driven straight from the simulation.
 */

const TAU = Math.PI * 2;
/** Tooth glow colours: north face / south face. */
const NORTH = new T.Color(0xff5a36);
const SOUTH = new T.Color(0x3d8bff);
const MAGNET_NORTH = 0xb5796b;
const MAGNET_SOUTH = 0x719aaf;

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

  const black = metal(0x20262c, 0.32);
  const edge = metal(0x111820, 0.22);
  const steel = metal(0xc3ccd2, 0.21, 0.95);
  const iron = metal(0x606b77, 0.45);
  const brass = metal(0xba9548, 0.24);
  const copper = metal(0xdb7b3f, 0.28);
  const matte = (color: number) => metal(color, 0.7, 0.1);
  /** Can surface: hidden in the cut-away view. */
  const shellParts: T.Object3D[] = [];

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
    return mesh(new T.CylinderGeometry(radius, radius, length, 96), material, parent, y);
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
      curveSegments: 64,
    });
    geo.rotateX(Math.PI / 2);
    return mesh(geo, material, parent, y + height / 2);
  }

  // ── Rotating bell ─────────────────────────────────────────────────────
  shellParts.push(
    mesh(new T.CylinderGeometry(1.02, 1.02, 2.2, 128, 1, true), black, bell, -0.15),
    mesh(
      new T.CylinderGeometry(0.98, 0.98, 2.2, 128, 1, true),
      new T.MeshStandardMaterial({
        color: 0x111820,
        roughness: 0.22,
        metalness: 0.8,
        side: T.BackSide,
      }),
      bell,
      -0.15,
    ),
  );
  // Closed rear end (opposite the output shaft), fixed to the shaft.
  cylinder(1.02, 0.16, black, bell, -1.28);
  cylinder(0.25, 0.15, steel, bell, -1.19);
  for (const side of [-1, 1]) {
    mesh(new T.BoxGeometry(0.72, 0.008, 0.09), edge, bell, -1.363).position.x = side * 0.67;
  }
  ring(1.02, 0.96, 0.045, edge, bell, 0.96);
  // Axial knurling on the can.
  const grooves = new T.InstancedMesh(new T.BoxGeometry(0.009, 2.06, 0.006), edge, 72);
  const placement = new T.Object3D();
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * TAU;
    placement.position.set(Math.sin(a) * 1.023, -0.15, Math.cos(a) * 1.023);
    placement.rotation.y = a;
    placement.updateMatrix();
    grooves.setMatrixAt(i, placement.matrix);
  }
  bell.add(grooves);
  shellParts.push(grooves);
  shellParts.push(createLabel(bell));

  // ── Shaft and bearing ─────────────────────────────────────────────────
  // Outer race stays in the flange; inner race turns with the shaft.
  ring(0.32, 0.2, 0.065, steel, stator, 1.29);
  ring(0.285, 0.21, 0.01, edge, stator, 1.328);
  ring(0.205, 0.165, 0.065, steel, rotor, 1.29);
  cylinder(0.165, 3.46, steel, rotor, 0.41);
  ring(0.205, 0.166, 0.018, brass, rotor, 1.375);
  const clip = mesh(new T.TorusGeometry(0.19, 0.012, 6, 48, Math.PI * 1.8), steel, rotor, 1.397);
  clip.rotation.x = Math.PI / 2;
  mesh(new T.BoxGeometry(0.075, 0.59, 0.014), edge, rotor, 1.79).position.z = 0.159;

  // ── Fixed flange, cable exit, leads ───────────────────────────────────
  ring(1.02, 0.35, 0.36, black, stator, 1.16, true);
  ring(0.35, 0.18, 0.12, black, stator, 1.2);
  mesh(new T.BoxGeometry(0.34, 0.23, 0.49), matte(0x171e25), stator, 1.13).position.x = 1.09;
  const leadColors = [0x47799f, 0x20262c, 0xe4b849];
  leadColors.forEach((color, i) => {
    const points = [
      new T.Vector3(1.18, 1.13, -0.14 + i * 0.14),
      new T.Vector3(1.58, 1.08, -0.14 + i * 0.14),
      new T.Vector3(2.06 + i * 0.07, 0.73, -0.06 + i * 0.19),
      new T.Vector3(2.56 + i * 0.08, 0.48, 0.12 + i * 0.22),
    ];
    const end = points[3]!;
    mesh(
      new T.TubeGeometry(new T.CatmullRomCurve3(points), 32, 0.046, 10, false),
      matte(0x171e25),
      stator,
    );
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

  // ── Stator: 12 wound teeth ────────────────────────────────────────────
  ring(0.36, 0.18, 1.8, iron, stator, 0);
  ring(0.29, 0.18, 0.22, black, stator, 0.96);
  const coilGeometry = createCoil();
  const coilMaterials = WINDING.map(() => copper.clone());
  for (let k = 0; k < SLOTS; k++) {
    const tooth = new T.Group();
    tooth.rotation.y = toothAzimuth(k);
    stator.add(tooth);
    mesh(new T.BoxGeometry(0.2, 1.62, 0.46), iron, tooth).position.z = 0.53;
    mesh(new T.BoxGeometry(0.3, 1.66, 0.08), iron, tooth).position.z = 0.79;
    mesh(coilGeometry, coilMaterials[k]!, tooth);
  }

  // ── Rotor: 14 magnets, N at even indices (electrical 0 at θm = 0) ────
  const magnets: T.Mesh[] = [];
  for (let i = 0; i < POLES; i++) {
    const a = (i / POLES) * TAU;
    const magnet = mesh(
      new T.BoxGeometry(0.31, 1.84, 0.065),
      metal(i % 2 ? MAGNET_SOUTH : MAGNET_NORTH, 0.36),
      bell,
      -0.15,
    );
    magnet.position.set(Math.sin(a) * 0.92, -0.15, Math.cos(a) * 0.92);
    magnet.rotation.y = a;
    magnet.userData.azimuth = a;
    magnets.push(magnet);
  }

  let open = false;
  return {
    root,
    rotor,
    stator,
    /** Cut-away view: hide the can, reveal the stator. */
    setOpen(value: boolean) {
      open = value;
      for (const part of shellParts) part.visible = !value;
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

/** Eleven rounded turns around a radial tooth, merged into one geometry. */
function createCoil() {
  const turns: T.BufferGeometry[] = [];
  for (let j = 0; j < 11; j++) {
    const z = 0.36 + j * 0.037;
    const points: T.Vector3[] = [];
    for (let k = 0; k < 48; k++) {
      const b = (k / 48) * TAU;
      // Superellipse: a rounded rectangle hugging the tooth.
      const x = 0.15 * Math.sign(Math.cos(b)) * Math.abs(Math.cos(b)) ** 0.35;
      const y = 0.9 * Math.sign(Math.sin(b)) * Math.abs(Math.sin(b)) ** 0.35;
      points.push(new T.Vector3(x, y, z));
    }
    turns.push(new T.TubeGeometry(new T.CatmullRomCurve3(points, true), 48, 0.018, 6, true));
  }
  const coil = mergeGeometries(turns)!;
  for (const turn of turns) turn.dispose();
  return coil;
}

/** Curved "FLIPSKY 5065" print on the can, rendered to a canvas texture. */
function createLabel(bell: T.Object3D) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;
  // The print runs axially, from the shaft-side flange toward the closed end.
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = "#d5d7cd";
  ctx.textAlign = "center";
  ctx.font = "700 190px Arial";
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
    new T.CylinderGeometry(1.027, 1.027, 1.95, 64, 1, true, -0.5, 1),
    new T.MeshStandardMaterial({
      map: texture,
      transparent: true,
      roughness: 0.55,
      metalness: 0.25,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
  );
  label.position.y = -0.15;
  bell.add(label);
  return label;
}
