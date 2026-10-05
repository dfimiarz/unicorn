import * as THREE from 'three';
import { H, WATER, GRAVITY } from './config.js';
import { clamp, smoothstep, wrapAngle, lerpAngle, rnd } from './util.js';
import { B } from './blocks.js';
import { rand, columnTop, getBlock } from './world.js';
import { scene } from './render.js';
import { Entity, physics, accelerate } from './physics.js';
import { box, pivot, fixed, shade, bake, nameTag, LEATHER, GOLD } from './modelkit.js';
import { spawnParticle } from './particles.js';
import { player } from './player.js';
import { state } from './state.js';

const tmp = new THREE.Vector3();

// Dragon rig, built like a winged T-rex: root → body pivot at the hips, balanced over two big
// bird-like hind legs (hip → knee → ankle → toes), a long tail held out behind as a counterweight,
// a neck chain → big head → jaw, and two bat-like wings on the back (no front legs, like a wyvern):
// shoulder → arm membrane, elbow → a fan of finger bones with membrane between them. The membranes
// sit in their own groups so folding can squash them flat along the bones.
const DRAGON_HIP_Y = 1.5;
const DRAGON_LEG = [0.6, 0.65, 0.4]; // thigh, shin, and the long upright foot bone (ankle to toes)
const DRAGON_NECK_REST = [0.7, 0.2, -0.3], DRAGON_NECK_FLY = [0.15, 0.02, -0.06];
const DRAGON_HEAD_Z = -0.38;
const DRAGON_ARM = 1.5, DRAGON_FINGERS = [[0.12, 2.3], [0.55, 2.05], [0.98, 1.65], [1.4, 1.25]]; // [angle back from the leading edge, length]
const CLAW = 0xf2ead2, MOUTH = 0x7a2228;
function makeDragonModel(c) {
  const root = new THREE.Group();
  const body = pivot(0, DRAGON_HIP_Y, 0, root);
  const dark = shade(c.body, 0.78);

  // hind legs: a heavy drumstick thigh angled forward, a shin angled back, then a long foot bone
  // standing up on three forward toes and a small back toe
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = pivot(s * 0.5, 0, 0, body);
    box(0.46, 0.6, 0.72, c.body, 0, -0.18, 0.02, hip);
    box(0.36, 0.3, 0.48, c.body, 0, -0.5, 0, hip);
    box(0.48, 0.1, 0.4, dark, 0, 0.1, 0.06, hip);
    const knee = pivot(0, -0.6, 0, hip);
    box(0.28, 0.7, 0.34, c.body, 0, -0.32, 0.03, knee);
    box(0.3, 0.3, 0.38, c.body, 0, -0.12, 0.05, knee);           // calf
    box(0.26, 0.1, 0.12, dark, 0, -0.05, -0.12, knee);
    const ankle = pivot(0, -0.65, 0, knee);
    box(0.2, 0.44, 0.2, c.body, 0, -0.2, 0, ankle);
    box(0.21, 0.38, 0.03, dark, 0, -0.2, -0.1, ankle);           // scales down the front
    box(0.12, 0.1, 0.14, dark, 0, 0.0, 0.1, ankle);              // heel spur
    const toes = pivot(0, -0.4, 0, ankle);
    for (let k = -1; k <= 1; k++) {
      const t = fixed(k * 0.1, 0, 0, toes);
      t.rotation.y = -k * 0.3;
      box(0.09, 0.08, 0.38, c.body, 0, -0.04, -0.17, t);
      box(0.07, 0.08, 0.12, CLAW, 0, -0.05, -0.41, t);
    }
    box(0.07, 0.07, 0.18, c.body, 0, -0.045, 0.1, toes);
    box(0.05, 0.06, 0.08, CLAW, 0, -0.05, 0.22, toes);
    legs.push({ hip, knee, ankle, toes });
  }

  // torso: hips, a level body and a deep chest, belly plates, flank scales and a row of spikes
  box(0.8, 0.75, 0.6, c.body, 0, 0.12, 0.05, body);
  box(0.84, 0.8, 1.3, c.body, 0, 0.12, -0.75, body);
  box(0.78, 0.86, 0.35, c.body, 0, 0.05, -1.5, body);
  box(0.66, 0.12, 0.6, c.body, 0, 0.56, -1.05, body);
  box(0.56, 0.6, 0.05, c.belly, 0, 0.0, -1.69, body);
  for (let i = 0; i < 6; i++) box(0.6, 0.06, 0.24, i % 2 ? c.belly : shade(c.belly, 0.9), 0, -0.3, -0.1 - i * 0.26, body);
  for (const s of [-1, 1]) for (let i = 0; i < 6; i++)
    box(0.012, 0.14, 0.22, i % 2 ? dark : shade(c.body, 0.88), s * 0.425, (i % 2) * 0.2, 0.1 - i * 0.27, body);
  for (let i = 0; i < 7; i++) {
    if (i >= 2 && i <= 4) continue; // the saddle sits here
    const h = 0.16 + 0.06 * Math.sin(i / 6 * Math.PI);
    box(0.06, h, 0.16, c.spike, 0, 0.52 + h / 2, 0.25 - i * 0.27, body);
  }

  // saddle: a blanket draped over the back with a gold trim, a seat with a high pommel to hold on
  // to and a cantle behind, a girth strap round the belly, and stirrups
  const blanket = shade(c.wing, 0.7);
  box(0.9, 0.04, 0.8, blanket, 0, 0.53, -0.45, body);
  for (const s of [-1, 1]) {
    box(0.03, 0.3, 0.8, blanket, s * 0.445, 0.39, -0.45, body);
    box(0.034, 0.03, 0.82, GOLD, s * 0.447, 0.245, -0.45, body);
    box(0.04, 0.8, 0.08, LEATHER, s * 0.44, 0.12, -0.45, body);
    box(0.03, 0.42, 0.04, LEATHER, s * 0.47, 0.3, -0.4, body);
    box(0.1, 0.03, 0.14, GOLD, s * 0.49, 0.09, -0.4, body);
  }
  box(0.86, 0.04, 0.08, LEATHER, 0, -0.34, -0.45, body);
  box(0.56, 0.1, 0.56, LEATHER, 0, 0.6, -0.45, body);
  box(0.26, 0.18, 0.1, LEATHER, 0, 0.72, -0.74, body);
  box(0.22, 0.04, 0.04, GOLD, 0, 0.83, -0.74, body);
  box(0.44, 0.16, 0.08, LEATHER, 0, 0.71, -0.17, body);
  box(0.45, 0.03, 0.09, GOLD, 0, 0.8, -0.17, body);
  const seat = pivot(0, 0.68, -0.45, body);

  // neck: a short, thick chain rising from the chest
  const neckSegs = [];
  let parent = pivot(0, 0.3, -1.6, body);
  for (let i = 0; i < 3; i++) {
    const seg = pivot(0, 0, i ? -0.38 : 0, parent), w = 0.52 - i * 0.04;
    box(w, w * 0.95, 0.44, c.body, 0, 0, -0.19, seg);
    box(w * 0.7, 0.05, 0.32, c.belly, 0, -w * 0.48, -0.19, seg);
    box(0.05, 0.14, 0.12, c.spike, 0, w * 0.48 + 0.06, -0.19, seg);
    neckSegs.push(seg);
    parent = seg;
  }

  // a big T-rex head
  const head = pivot(0, 0, DRAGON_HEAD_Z, parent);
  box(0.58, 0.46, 0.58, c.body, 0, 0.08, -0.22, head);               // skull
  box(0.44, 0.28, 0.62, c.body, 0, 0.02, -0.76, head);               // snout
  box(0.16, 0.05, 0.52, dark, 0, 0.18, -0.7, head);                  // ridge along the snout
  for (const s of [-1, 1]) {
    box(0.14, 0.09, 0.34, dark, s * 0.2, 0.33, -0.27, head);          // brow
    box(0.07, 0.05, 0.03, 0x1a0e0a, s * 0.12, 0.1, -1.075, head);     // nostril
    for (let k = 0; k < 4; k++) box(0.035, 0.07, 0.035, CLAW, s * 0.19, -0.14, -0.55 - k * 0.14, head); // fangs
    for (let k = 0; k < 3; k++) box(0.03, 0.16 - k * 0.03, 0.12, c.wing, s * 0.3, 0.04 - k * 0.09, -0.02 + k * 0.07, head); // cheek frills
    // horns sweep back and a little outward, in three tapering pieces
    const h1 = fixed(s * 0.19, 0.3, -0.02, head);
    h1.rotation.set(1.0, 0, -s * 0.3);
    box(0.12, 0.28, 0.12, c.horn, 0, 0.13, 0, h1);
    const h2 = fixed(0, 0.27, 0, h1);
    h2.rotation.x = 0.35;
    box(0.085, 0.24, 0.085, c.horn, 0, 0.11, 0, h2);
    box(0.05, 0.18, 0.05, shade(c.horn, 0.85), 0, 0.3, 0, h2);
  }
  const jaw = pivot(0, -0.13, -0.18, head);
  box(0.4, 0.14, 0.86, c.body, 0, -0.05, -0.42, jaw);
  box(0.3, 0.03, 0.74, c.belly, 0, -0.13, -0.4, jaw);
  box(0.32, 0.02, 0.72, MOUTH, 0, 0.022, -0.44, jaw);
  for (const s of [-1, 1]) for (let k = 0; k < 3; k++) box(0.035, 0.06, 0.035, CLAW, s * 0.16, 0.05, -0.75 + k * 0.16, jaw);
  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = box(0.04, 0.11, 0.15, c.eye, s * 0.29, 0.19, -0.33, head);
    eye.userData.bake = false; // kept separate so it can blink
    box(0.012, 0.1, 0.03, 0x111111, s * 0.022, 0, 0, eye); // slit pupil
    eyes.push(eye);
  }

  // tail: a long tapering chain held out behind (+z), ending in a spade
  const tail = pivot(0, 0.2, 0.32, body);
  const tailSegs = [];
  parent = tail;
  for (let i = 0; i < 8; i++) {
    const seg = pivot(0, 0, i ? 0.42 : 0, parent), w = 0.06 + 0.5 * (1 - i / 8);
    box(w, w * 0.9, 0.46, c.body, 0, 0, 0.21, seg);
    box(w * 0.7, 0.04, 0.34, c.belly, 0, -w * 0.45, 0.21, seg);
    box(0.05, 0.08 + w * 0.2, 0.14, c.spike, 0, w * 0.45 + 0.05, 0.21, seg);
    tailSegs.push(seg);
    parent = seg;
  }
  const spade = fixed(0, 0, 0.55, parent);
  spade.rotation.y = Math.PI / 4;
  box(0.36, 0.04, 0.36, c.wing, 0, 0, 0, spade);
  box(0.2, 0.06, 0.2, c.spike, 0, 0, 0, spade);

  const wings = [makeDragonWing(-1, body, c), makeDragonWing(1, body, c)];

  bake(root);
  scene.add(root);
  return { root, body, seat, legs, neckSegs, head, jaw, eyes, tail, tailSegs, wings };
}

// Bat-like wing (s = -1 left, +1 right). Local frame: span along s*x, membrane trails toward +z.
// Shoulder rotation order YXZ = flap (z), then twist (x), then sweep (y), like the unicorn's wings.
function makeDragonWing(s, parent, c) {
  const A = DRAGON_ARM;
  const shoulder = pivot(s * 0.36, 0.5, -1.0, parent);
  shoulder.rotation.order = 'YXZ';
  box(0.55, 0.24, 0.24, c.body, s * 0.27, 0, 0, shoulder);
  box(A, 0.15, 0.15, c.body, s * A / 2, 0, 0, shoulder);
  const armMem = pivot(0, 0, 0, shoulder);
  box(A, 0.025, 1.0, c.wing, s * A / 2, -0.02, 0.52, armMem);
  box(0.9, 0.025, 0.45, c.wing, s * 0.45, -0.02, 1.24, armMem);
  const elbow = pivot(s * A, 0, 0, shoulder);
  elbow.rotation.order = 'YXZ';
  box(0.2, 0.2, 0.2, c.body, 0, 0, 0, elbow);
  box(0.07, 0.14, 0.18, CLAW, s * 0.04, 0.11, -0.11, elbow); // thumb claw
  const fan = pivot(0, 0, 0, elbow);
  DRAGON_FINGERS.forEach(([a, len], i) => {
    const f = fixed(0, 0, 0, fan);
    f.rotation.y = -s * a;
    box(len, 0.09, 0.09, shade(c.body, 0.9), s * len / 2, 0.01, 0, f);
    if (i === 0) box(0.16, 0.07, 0.07, CLAW, s * (len + 0.06), 0.01, 0, f);
    if (i === DRAGON_FINGERS.length - 1) return;
    // membrane between this finger and the next, built as a stepped triangle out to the shorter one
    const [a2, len2] = DRAGON_FINGERS[i + 1], half = (a2 - a) / 2, L = Math.min(len, len2) * 0.97;
    const p = fixed(0, 0, 0, fan);
    p.rotation.y = -s * (a + half);
    for (let j = 0; j < 4; j++) {
      const r0 = j * L / 4, r1 = (j + 1) * L / 4;
      box(r1 - r0 + 0.02, 0.02, 2 * r1 * Math.tan(half) + 0.04, j % 2 ? c.wing : shade(c.wing, 0.93), s * (r0 + r1) / 2, -0.01, 0, p);
    }
  });
  return { shoulder, elbow, armMem, fan, s };
}

// Walking like a big bird: the feet take turns, each planted on the ground while the body passes
// over it, then picked up with the toes curled and swung forward for the next step.
const DRAGON_STRIDE = 1.7, DRAGON_DUTY = 0.6;
// leg poses in the air, as [hip, knee, ankle, toes]: streaming back in flight, reaching down to land
const DRAGON_FLY_LEG = [-1.1, -0.5, 0.5, 0.9], DRAGON_LAND_LEG = [0.7, -0.9, 0.6, -0.4];
const legIK = [0, 0, 0, 0];
// Pose a hind leg so the ball of the foot sits `fwd` ahead of and `down` below the hip: the foot
// bone is held at angle `meta`, and the thigh and shin are solved as a two-bone chain with the knee
// pointing forward. Angles are measured from straight down, + forward; returns the joint rotations.
function dragonLegIK(fwd, down, meta, toe) {
  const [L1, L2, L3] = DRAGON_LEG;
  const ax = fwd - L3 * Math.sin(meta), ay = down - L3 * Math.cos(meta);
  const d = clamp(Math.hypot(ax, ay), 0.1, (L1 + L2) * 0.999), phi = Math.atan2(ax, ay);
  const thigh = phi + Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const shin = phi - Math.acos(clamp((L2 * L2 + d * d - L1 * L1) / (2 * L2 * d), -1, 1));
  legIK[0] = thigh; legIK[1] = shin - thigh; legIK[2] = meta - shin; legIK[3] = toe - meta;
  return legIK;
}

function animateDragonWings(d, dt, takeoffC) {
  const flying = d.state === 'fly' || d.state === 'land';
  let fold = 1, amp = 0, freq = 1, dihedral = 0.12;
  if (flying) {
    fold = 0;
    const flare = (d.state === 'land' || d.fvy < -1) && d.pos.y - d.groundY < 4;
    if (flare || d.fvy > 1.2 || d.hitWall || Math.hypot(d.vel.x, d.vel.z) < 3) { amp = 0.8; freq = 1.3; } // climbing, hovering, or flaring to land
    else if (d.fvy < -4) { fold = 0.35; amp = 0.05; freq = 2; }                // diving: swept back
    else {
      // cruising: long glides with a few lazy wingbeats now and then
      d.glideT -= dt;
      if (d.glideT <= 0) { d.flapping = !d.flapping; d.glideT = d.flapping ? 1.5 + Math.random() : 2 + Math.random() * 3; }
      if (d.flapping) { amp = 0.55; freq = 1.05; } else { amp = 0.04; freq = 0.5; dihedral = 0.18; }
    }
  } else if (d.state === 'takeoff') { fold = 1 - takeoffC; amp = 0.3 * takeoffC; freq = 1.2; }
  else if (d.idle === 'stretch') {
    const s = d.idleT / 2.6;
    fold = 1 - Math.sin(Math.PI * Math.min(1, s)); amp = 0.4; freq = 0.9;
  }
  const k = Math.min(1, dt * 4);
  d.wingFold += (fold - d.wingFold) * k;
  d.wingAmp += (amp - d.wingAmp) * k;
  d.wingFreq += (freq - d.wingFreq) * k;
  d.wingDihedral += (dihedral - d.wingDihedral) * k;
  d.wingP += dt * d.wingFreq * Math.PI * 2;
  const f = d.wingFold, open = 1 - f, beat = Math.sin(d.wingP);
  for (const w of d.model.wings) {
    const s = w.s;
    // folded: the arm rises up and back so the wrist peaks above the shoulders, and the hand runs
    // back down to a wingtip beside the tail. Both membranes are rolled into the plane of that
    // triangle and only partly gathered in, so the folded wing drapes down the side as a big sail.
    w.shoulder.rotation.set(
      open * d.wingAmp * 0.15 * Math.cos(d.wingP) + 0.61 * f,
      s * 0.24 * f,
      s * (open * (d.wingDihedral + d.wingAmp * beat) + 1.4 * f));
    w.elbow.rotation.set(0, -s * 1.71 * f, s * open * d.wingAmp * 0.5 * Math.sin(d.wingP - 0.9));
    w.fan.scale.z = 1 - 0.35 * f;
    w.armMem.scale.z = 1 - 0.3 * f;
  }
  return -beat * 0.1 * d.wingAmp * open;
}

function animateDragon(d, dt) {
  const md = d.model;
  const hs = Math.hypot(d.vel.x, d.vel.z);
  const move = Math.min(1, hs / 0.6);
  const flying = d.state === 'fly' || d.state === 'land';
  d.flyW += ((flying ? 1 : 0) - d.flyW) * Math.min(1, dt * 3);
  const walkAmt = move * (1 - d.flyW);

  // two steps per stride: the body bobs on each, rolls over the planted foot, and the hips swivel;
  // running (when ridden) takes longer strides with the body crouched lower and leaning forward
  const run = clamp((hs - 2) / 4, 0, 1) * (1 - d.flyW);
  const stride = DRAGON_STRIDE + 0.6 * run;
  d.phase = (d.phase + dt * hs / stride) % 1;
  const P = d.phase * Math.PI * 2;
  let bob = 0.04 * Math.cos(2 * P) * walkAmt - 0.1 * run, sway = Math.sin(P) * 0.06 * walkAmt, roll = Math.sin(P) * 0.05 * walkAmt;
  let pitch = 0.05 + 0.02 * Math.sin(2 * P) * walkAmt - 0.1 * run;

  // crouch before springing into the air (the legs bend to follow the lowered hips)
  let takeoffC = 0;
  if (d.state === 'takeoff') {
    takeoffC = Math.min(1, d.stateT / 0.5);
    bob -= 0.35 * takeoffC; pitch -= 0.15 * takeoffC;
  }
  // landing squash
  d.landT = Math.max(0, d.landT - dt * 3);
  bob -= 0.25 * d.landT;

  // in the air: pitch with the climb, bank into turns, legs reach down on the way in to land
  const yawRate = wrapAngle(d.yaw - d.prevYaw) / Math.max(dt, 1e-4);
  d.prevYaw = d.yaw;
  d.turn += (yawRate - d.turn) * Math.min(1, dt * 4);
  const reach = d.state === 'land' || (d.state === 'fly' && d.fvy < -1) ? clamp(1 - (d.pos.y - d.groundY - 1) / 4, 0, 1) : 0;
  d.reachW += (reach - d.reachW) * Math.min(1, dt * 4);
  if (d.flyW > 0.001) {
    pitch += (clamp(d.fvy * 0.05, -0.25, 0.3) - 0.05 + 0.2 * d.reachW) * d.flyW;
    roll += clamp(d.turn * 0.6, -0.5, 0.5) * d.flyW;
  }

  // legs: the walk cycle solved onto the ground, blended into the flying pose
  const R = stride * DRAGON_DUTY / 2 * walkAmt;
  md.legs.forEach((L, i) => {
    const q = (d.phase + i * 0.5) % 1;
    let fwd, lift = 0, meta = 0.25, toe = 0;
    if (q < DRAGON_DUTY) {
      fwd = R * (1 - 2 * q / DRAGON_DUTY);
      meta += 0.35 * smoothstep(DRAGON_DUTY - 0.2, DRAGON_DUTY, q) * walkAmt; // heel peels up to push off
    } else {
      const s = (q - DRAGON_DUTY) / (1 - DRAGON_DUTY), up = Math.sin(Math.PI * s);
      fwd = -R + R * (1 - Math.cos(Math.PI * s));
      lift = 0.32 * up * walkAmt;
      meta += 0.4 * up * walkAmt;
      toe = -0.7 * up * walkAmt; // toes curl under as the foot swings through
    }
    const j = dragonLegIK(fwd, DRAGON_HIP_Y + bob - 0.08 - lift, meta, toe);
    j[0] -= pitch;
    const air = d.flyW;
    for (let k = 0; k < 4; k++) j[k] += (DRAGON_FLY_LEG[k] + (DRAGON_LAND_LEG[k] - DRAGON_FLY_LEG[k]) * d.reachW - j[k]) * air;
    L.hip.rotation.x = j[0]; L.knee.rotation.x = j[1]; L.ankle.rotation.x = j[2]; L.toes.rotation.x = j[3];
  });

  // idle: look around, stretch the wings, and puff smoke from the nostrils
  d.idleCd -= dt;
  if (!d.idle && d.idleCd <= 0 && d.state === 'idle') {
    const r = Math.random();
    d.idle = r < 0.45 ? 'look' : r < 0.7 ? 'stretch' : 'smoke';
    d.idleT = 0; d.lookTo = rnd(-0.9, 0.9);
    d.idleCd = 3 + Math.random() * 5;
  }
  let neckYaw = clamp(d.turn * 0.25, -0.5, 0.5) * (1 - d.flyW), jawOpen = 0, headUp = 0;
  if (d.idle) {
    d.idleT += dt;
    const len = d.idle === 'stretch' ? 2.6 : d.idle === 'smoke' ? 1.6 : 2.4;
    const s = d.idleT / len, env = Math.sin(Math.PI * Math.min(1, s));
    if (d.idle === 'look') neckYaw += d.lookTo * env;
    else if (d.idle === 'stretch') headUp += 0.25 * env;
    else {
      headUp += 0.2 * env; jawOpen = 0.35 * env;
      if (s > 0.3 && s < 0.7 && Math.random() < dt * 25) {
        md.head.localToWorld(tmp.set(rnd(-0.12, 0.12), 0.12, -1.1));
        const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw);
        spawnParticle(tmp, fx * rnd(0.6, 1.4), rnd(0.6, 1.4), fz * rnd(0.6, 1.4), Math.random() < 0.2 ? 0xff8a2a : Math.random() < 0.5 ? 0x9a9a9a : 0x6e6e6e, rnd(0.8, 1.4), -0.8, rnd(1.3, 2.2));
      }
    }
    if (s >= 1 || d.state !== 'idle') d.idle = null;
  }

  bob += animateDragonWings(d, dt, takeoffC);

  // apply
  md.body.position.y = DRAGON_HIP_Y + bob + Math.sin(state.time * 1.6 + d.breath) * 0.012;
  md.body.rotation.set(pitch, sway, roll);
  let neckPitch = 0;
  md.neckSegs.forEach((s, i) => {
    s.rotation.x = DRAGON_NECK_REST[i] + (DRAGON_NECK_FLY[i] - DRAGON_NECK_REST[i]) * d.flyW + headUp * 0.4
      + Math.sin(state.time * 1.3 + d.breath - i * 0.5) * 0.03;
    s.rotation.y = neckYaw / 3 - sway * 0.8;
    neckPitch += s.rotation.x;
  });
  // keep the head roughly level whatever the neck and body are doing; while walking it holds still
  // in the air then darts forward on each step, like a chicken's
  md.head.rotation.x = -(neckPitch + pitch) * 0.8 + headUp;
  const step = (d.phase * 2) % 1, hold = step < 0.75 ? step / 0.75 : 1 - (step - 0.75) / 0.25;
  md.head.position.z = DRAGON_HEAD_Z + (hold - 0.5) * 0.24 * walkAmt;
  md.jaw.rotation.x = -jawOpen;

  // tail held out level as a counterweight, swinging against the hips; streams straight out in flight
  md.tail.rotation.x = 0.04 - pitch * 0.5;
  md.tailSegs.forEach((s, i) => {
    s.rotation.x = 0.015 * (1 - d.flyW) + Math.sin(state.time * 2 - i * 0.6) * 0.04 * d.flyW;
    s.rotation.y = -Math.sin(P - i * 0.5) * 0.1 * walkAmt + Math.sin(state.time * 0.9 + d.breath - i * 0.5) * 0.05
      - clamp(d.turn * 0.08, -0.12, 0.12);
  });

  d.blinkT -= dt;
  if (d.blinkT <= 0) d.blinkT = 2 + Math.random() * 5;
  for (const e of md.eyes) e.scale.y = d.blinkT < 0.14 ? 0.15 : 1;

  md.root.position.copy(d.pos);
  md.root.rotation.y = d.yaw;
  md.root.updateMatrixWorld(true);
  md.seat.getWorldPosition(d.seatWorld);
}

const DRAGON_HOME_RADIUS = 55; // flying dragons turn back toward the island past this
export function updateDragon(d, dt) {
  d.aiTimer -= dt;
  d.turnCd -= dt;
  d.stateT += dt;
  const gx = Math.floor(d.pos.x), gz = Math.floor(d.pos.z);
  d.groundY = Math.max(columnTop(gx, gz), WATER) + 1;
  const setState = (s, t) => { d.state = s; d.stateT = 0; d.aiTimer = t; };

  if (d.rider) {
    // steered by the player (see rideDragon)
  } else if (d.state === 'fly' || d.state === 'land') {
    // wander in lazy curves, heading back over the island if it strays out to sea
    d.wanderYaw += Math.sin(state.time * 0.3 + d.breath) * dt * 0.6;
    const hx = -d.pos.x, hz = -d.pos.z;
    if (Math.hypot(hx, hz) > DRAGON_HOME_RADIUS) d.wanderYaw = lerpAngle(d.wanderYaw, Math.atan2(-hx, -hz), dt * 1.2);
    const sp = d.state === 'land' ? 3 : 7;
    const dx = -Math.sin(d.wanderYaw), dz = -Math.cos(d.wanderYaw);
    const ahead = Math.max(columnTop(Math.floor(d.pos.x + dx * 6), Math.floor(d.pos.z + dz * 6)), WATER) + 1;
    let vy;
    if (d.state === 'fly') {
      vy = clamp((Math.max(d.groundY, ahead) + d.cruise - d.pos.y) * 0.6, -3, 5);
      // come down once the time's up, but only onto open ground (not the sea or a treetop)
      const top = columnTop(gx, gz);
      if (d.aiTimer <= 0 && top > WATER + 1 && getBlock(gx, top, gz) !== B.LEAVES) setState('land', 0);
    } else {
      vy = d.pos.y - Math.max(d.groundY, ahead) > 4 ? -4 : -2;
      if (columnTop(gx, gz) <= WATER) setState('fly', 3); // drifted out over the water
    }
    if (d.hitWall) vy = 5;
    if (d.pos.y > H + 20) vy = Math.min(vy, 0);
    d.fvy += (vy - d.fvy) * Math.min(1, dt * 2);
    d.vel.y = d.fvy + GRAVITY * dt; // cancels the gravity physics() is about to add
    accelerate(d, dx * sp, dz * sp, dt, 1.5);
    d.yaw = lerpAngle(d.yaw, d.wanderYaw, dt * 2);
    d.glide = false;
    physics(d, dt);
    if (d.state === 'land' && d.onGround) { setState('idle', 2 + rand() * 3); d.landT = 1; d.fvy = 0; }
  } else {
    if (d.state === 'takeoff') {
      if (d.stateT > 0.5) { setState('fly', 10 + rand() * 12); d.cruise = 9 + rand() * 9; d.fvy = 7; d.wanderYaw = d.yaw; }
    } else if (d.inWater || (d.state === 'walk' && d.stuckT > 1.2)) setState('takeoff', 0);
    else if (d.aiTimer <= 0) {
      const r = rand();
      if (r < 0.3) setState('idle', 2 + rand() * 4);
      else if (r < 0.85) { setState('walk', 3 + rand() * 5); d.wanderYaw = rand() * Math.PI * 2; }
      else setState('takeoff', 0);
    }
    let tx = 0, tz = 0;
    if (d.state === 'walk') {
      const dx = -Math.sin(d.wanderYaw), dz = -Math.cos(d.wanderYaw);
      // turn around before walking into the sea
      if (d.turnCd <= 0 && columnTop(Math.floor(d.pos.x + dx * 4), Math.floor(d.pos.z + dz * 4)) <= WATER) {
        d.wanderYaw += Math.PI + (rand() - 0.5);
        d.turnCd = 1;
      }
      tx = dx * d.walkSpeed; tz = dz * d.walkSpeed;
      d.yaw = lerpAngle(d.yaw, d.wanderYaw, dt * 2.5);
      if (d.hitWall && d.onGround) d.vel.y = 9;
    }
    d.stuckT = d.state === 'walk' && d.hitWall ? d.stuckT + dt : 0;
    accelerate(d, tx, tz, dt, 3);
    d.glide = false;
    physics(d, dt);
  }

  animateDragon(d, dt);
  const tagDist = d.pos.distanceTo(player.pos);
  d.tag.visible = !d.rider && tagDist > 4 && tagDist < 20;
}

// Riding a dragon: run on the ground, Space to take off and climb, Shift to dive. With neither
// held it keeps its height, hovering when slow. Coming down onto the ground lands it.
const DRAGON_RUN_SPEED = 6, DRAGON_FLY_SPEED = 13;
export function rideDragon(d, dt, mx, mz, back, space, shift) {
  const len = Math.hypot(mx, mz);
  d.glide = false;
  if (d.state === 'fly') {
    if (len > 0) d.yaw = lerpAngle(d.yaw, Math.atan2(-mx, -mz), dt * 4);
    const sp = DRAGON_FLY_SPEED * (back ? 0.5 : 1);
    accelerate(d, mx * sp, mz * sp, dt, 2);
    d.fvy += ((space ? 6 : shift ? -9 : 0) - d.fvy) * Math.min(1, dt * 3);
    if (d.pos.y > H + 20) d.fvy = Math.min(d.fvy, 0);
    if (d.pos.y < WATER + 0.6) d.fvy = Math.max(d.fvy, 0); // skim over the sea rather than dive in
    d.vel.y = d.fvy + GRAVITY * dt; // cancels the gravity physics() is about to add
    physics(d, dt);
    if (d.onGround && d.fvy <= 0) { d.state = 'idle'; d.stateT = 0; d.landT = 1; d.fvy = 0; }
    return;
  }
  if (d.state === 'takeoff') {
    if (d.stateT > 0.3) { d.state = 'fly'; d.stateT = 0; d.fvy = 7; }
  } else if (space) { d.state = 'takeoff'; d.stateT = 0.15; } // a quick crouch, then up
  else d.state = len > 0 ? 'walk' : 'idle';
  if (len > 0 && d.state !== 'takeoff') d.yaw = lerpAngle(d.yaw, Math.atan2(-mx, -mz), dt * 6);
  const sp = d.state === 'takeoff' ? 0 : DRAGON_RUN_SPEED * (back ? 0.5 : 1) * (d.inWater ? 0.4 : 1);
  accelerate(d, mx * sp, mz * sp, dt, 3);
  if (d.hitWall && d.onGround && len > 0) d.vel.y = 9; // hop up single blocks
  if (d.inWater && !space) d.vel.y = Math.max(d.vel.y, 1.5);
  physics(d, dt);
}

export const DRAGON_COLORS = [
  { name: 'Ember', body: 0xa8302a, belly: 0xf0b860, wing: 0xe2683e, spike: 0x3a1a14, horn: 0xeadfc8, eye: 0xffd23a },
  { name: 'Jade', body: 0x2f7d45, belly: 0xd6dd8a, wing: 0x72c08a, spike: 0x1b4528, horn: 0xe8e0c0, eye: 0xffb030 },
  { name: 'Sapphire', body: 0x2c56a8, belly: 0xa8d0f0, wing: 0x6c9ae6, spike: 0x172656, horn: 0xdcdcec, eye: 0xfff07a },
  { name: 'Amethyst', body: 0x6a3aa0, belly: 0xe2c4f0, wing: 0xb47ce0, spike: 0x2e1650, horn: 0xf0e4d0, eye: 0x7affd0 },
];
export const dragons = [];
export function makeDragon(c, p) {
  const d = new Entity(0.6, 2.3);
  Object.assign(d, {
    kind: 'dragon', name: c.name, label: `${c.name} the Dragon`, model: makeDragonModel(c), walkSpeed: 1.8,
    rider: null, baseH: 2.3, riddenH: 3.4, seatRestY: DRAGON_HIP_Y + 0.68, seatWorld: new THREE.Vector3(),
    state: 'idle', stateT: 0, aiTimer: 1 + rand() * 3, turnCd: 0, stuckT: 0, cruise: 12, groundY: p.y,
    phase: 0, flyW: 0, reachW: 0, fvy: 0, landT: 0, turn: 0, idle: null, idleT: 0, idleCd: 2 + Math.random() * 4, lookTo: 0,
    blinkT: Math.random() * 4, breath: Math.random() * 6, glideT: 0, flapping: false,
    wingFold: 1, wingAmp: 0, wingFreq: 1, wingDihedral: 0.12, wingP: 0,
  });
  d.pos.copy(p);
  d.yaw = d.wanderYaw = d.prevYaw = rand() * Math.PI * 2;
  d.tag = nameTag('🐉 ' + c.name);
  d.tag.position.set(0, 3.6, 0);
  d.model.root.add(d.tag);
  dragons.push(d);
  return d;
}
