import * as THREE from 'three';
import { H, WATER, GRAVITY } from './config.js';
import { clamp, smoothstep, wrapAngle, lerpAngle, rnd } from './util.js';
import { B } from './blocks.js';
import { rand, columnTop, getBlock } from './world.js';
import { scene } from './render.js';
import { Entity, physics, accelerate } from './physics.js';
import { box, pivot, fixed, shade, bake, nameTag, barrelRoll, LEATHER, GOLD } from './modelkit.js';
import { spawnParticle } from './particles.js';
import { scorch, fireIn, FIRE_COLORS } from './fire.js';
import { popBubblesNear } from './bubbles.js';
import { player } from './player.js';
import { raycast } from './camera.js';
import { state } from './state.js';

const tmp = new THREE.Vector3();

// The screech a dragon lets out as it starts a barrel roll or is hurt, quieter the further off it is,
// and higher pitched from a smaller dragon (d.voice)
const SCREECH = new Audio('screech.m4a'), SCREECH_RANGE = 80;
function screech(d) {
  const vol = 1 - d.pos.distanceTo(player.pos) / SCREECH_RANGE;
  if (vol <= 0) return;
  const s = SCREECH.cloneNode(); // a fresh copy so screeches from several dragons can overlap
  s.volume = Math.min(1, vol);
  s.playbackRate = d.voice; s.preservesPitch = false;
  s.play().catch(() => {}); // the browser may refuse before the page has been clicked
}

// Dragon rig, built like a winged T-rex: root → body pivot at the hips, balanced over two big
// bird-like hind legs (hip → knee → ankle → toes), a long tail held out behind as a counterweight,
// a neck chain → big head → jaw, and two big feathered wings on the back (no front legs, like a
// wyvern): shoulder → arm with its feathers, elbow → hand with a fan of long flight feathers. The
// feathers sit in their own groups so folding can gather them in along the bones.
const DRAGON_HIP_Y = 1.5;
const DRAGON_LEG = [0.6, 0.65, 0.4]; // thigh, shin, and the long upright foot bone (ankle to toes)
const DRAGON_NECK_REST = [0.7, 0.2, -0.3], DRAGON_NECK_FLY = [0.15, 0.02, -0.06];
const DRAGON_HEAD_Z = -0.38;
const DRAGON_ARM = 1.8, DRAGON_HAND = 1.1;
const CLAW = 0xf2ead2, MOUTH = 0x7a2228;
// Overlapping scales on one side (s = -1 left, +1 right) of a part whose side face is at x = s*x:
// staggered rows of thin plates over y0..y1 and z0..z1, every other row set half a scale along
// like roof tiles, in a few shades of the body colour.
function scales(s, x, y0, y1, z0, z1, rows, cols, colors, parent) {
  const dy = (y1 - y0) / rows, dz = (z1 - z0) / cols;
  for (let r = 0; r < rows; r++) {
    const shift = r % 2 ? 0.5 : 0;
    for (let k = 0; k < cols - shift * 2; k++)
      box(0.016, dy * 0.82, dz * 0.82, colors[(r + 2 * k) % colors.length], s * (x + 0.008), y0 + (r + 0.5) * dy, z0 + (k + 0.5 + shift) * dz, parent);
  }
}

function makeDragonModel(c) {
  const root = new THREE.Group();
  const body = pivot(0, DRAGON_HIP_Y, 0, root);
  const dark = shade(c.body, 0.78);
  const scaleCols = [shade(c.body, 0.85), shade(c.body, 1.12), shade(c.body, 0.95)];

  // hind legs: a drumstick thigh, a shin angled back, then a long foot bone standing up on three
  // forward toes and a small back toe
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = pivot(s * 0.38, 0, 0, body);
    box(0.34, 0.6, 0.6, c.body, 0, -0.18, 0.02, hip);
    box(0.26, 0.3, 0.4, c.body, 0, -0.5, 0, hip);
    scales(s, 0.17, -0.42, 0.08, -0.22, 0.26, 3, 3, scaleCols, hip);
    const knee = pivot(0, -0.6, 0, hip);
    box(0.22, 0.7, 0.28, c.body, 0, -0.32, 0.03, knee);
    for (let j = 0; j < 4; j++) box(0.18, 0.13, 0.016, j % 2 ? dark : shade(dark, 1.15), 0, -0.1 - j * 0.15, -0.118, knee); // scutes
    const ankle = pivot(0, -0.65, 0, knee);
    box(0.16, 0.44, 0.16, dark, 0, -0.2, 0, ankle);
    for (let j = 0; j < 3; j++) box(0.13, 0.11, 0.016, j % 2 ? shade(dark, 0.9) : shade(dark, 1.2), 0, -0.07 - j * 0.13, -0.088, ankle);
    const toes = pivot(0, -0.4, 0, ankle);
    for (let k = -1; k <= 1; k++) {
      const t = fixed(k * 0.09, 0, 0, toes);
      t.rotation.y = -k * 0.3;
      box(0.08, 0.08, 0.36, c.body, 0, -0.04, -0.16, t);
      box(0.06, 0.07, 0.1, CLAW, 0, -0.05, -0.39, t);
    }
    box(0.06, 0.06, 0.18, c.body, 0, -0.045, 0.1, toes);
    legs.push({ hip, knee, ankle, toes });
  }

  // torso: hips, a level body and chest, scaly flanks, belly plates and a row of spikes down the back
  box(0.58, 0.72, 0.6, c.body, 0, 0.12, 0.05, body);
  box(0.62, 0.8, 1.3, c.body, 0, 0.12, -0.75, body);
  box(0.56, 0.84, 0.35, c.body, 0, 0.05, -1.5, body);
  box(0.42, 0.6, 0.05, c.belly, 0, 0.0, -1.69, body);
  for (const s of [-1, 1]) {
    scales(s, 0.31, -0.24, 0.22, -1.38, -0.12, 3, 8, scaleCols, body);
    scales(s, 0.31, 0.24, 0.5, -1.38, -0.88, 2, 3, scaleCols, body); // in front of the saddle
  }
  for (let i = 0; i < 5; i++) box(0.44, 0.06, 0.22, i % 2 ? c.belly : shade(c.belly, 0.9), 0, -0.3, -0.2 - i * 0.26, body);
  for (const i of [0, 1, 5, 6]) { // the saddle sits in the gap
    const h = 0.16 + 0.06 * Math.sin(i / 6 * Math.PI);
    box(0.06, h, 0.16, c.spike, 0, 0.52 + h / 2, 0.25 - i * 0.27, body);
  }

  // saddle: a blanket over the back, a seat with a pommel to hold on to and a cantle behind, a girth
  // strap round the belly, and stirrups
  const blanket = shade(c.wing, 0.7);
  box(0.68, 0.04, 0.8, blanket, 0, 0.53, -0.45, body);
  for (const s of [-1, 1]) {
    box(0.03, 0.3, 0.8, blanket, s * 0.325, 0.39, -0.45, body);
    box(0.034, 0.03, 0.82, GOLD, s * 0.327, 0.245, -0.45, body);
    box(0.03, 0.42, 0.04, LEATHER, s * 0.35, 0.3, -0.4, body);
    box(0.1, 0.03, 0.14, GOLD, s * 0.37, 0.09, -0.4, body);
  }
  box(0.66, 0.04, 0.08, LEATHER, 0, -0.32, -0.45, body);
  box(0.5, 0.1, 0.56, LEATHER, 0, 0.6, -0.45, body);
  box(0.24, 0.18, 0.1, LEATHER, 0, 0.72, -0.74, body);
  box(0.4, 0.16, 0.08, LEATHER, 0, 0.71, -0.17, body);
  const seat = pivot(0, 0.68, -0.45, body);

  // neck: a short chain rising from the chest
  const neckSegs = [];
  let parent = pivot(0, 0.3, -1.6, body);
  for (let i = 0; i < 3; i++) {
    const seg = pivot(0, 0, i ? -0.38 : 0, parent), w = 0.42 - i * 0.04;
    box(w, w * 0.95, 0.44, c.body, 0, 0, -0.19, seg);
    box(w * 0.7, 0.05, 0.32, c.belly, 0, -w * 0.48, -0.19, seg);
    box(0.05, 0.14, 0.12, c.spike, 0, w * 0.48 + 0.06, -0.19, seg);
    for (const s of [-1, 1]) scales(s, w / 2, -w * 0.3, w * 0.3, -0.36, -0.02, 2, 3, scaleCols, seg);
    neckSegs.push(seg);
    parent = seg;
  }

  // a big T-rex head
  const head = pivot(0, 0, DRAGON_HEAD_Z, parent);
  box(0.5, 0.44, 0.56, c.body, 0, 0.08, -0.22, head);                // skull
  box(0.38, 0.28, 0.62, c.body, 0, 0.02, -0.76, head);               // snout
  for (let k = 0; k < 3; k++) box(0.14, 0.016, 0.12, k % 2 ? dark : shade(dark, 1.15), 0, 0.168, -0.56 - k * 0.16, head); // scutes
  for (const s of [-1, 1]) {
    box(0.12, 0.09, 0.32, dark, s * 0.18, 0.32, -0.27, head);         // brow
    box(0.06, 0.05, 0.03, 0x1a0e0a, s * 0.1, 0.1, -1.075, head);      // nostril
    scales(s, 0.25, -0.12, 0.1, -0.46, -0.04, 2, 3, scaleCols, head);  // cheeks
    scales(s, 0.19, -0.06, 0.14, -1.0, -0.5, 2, 4, scaleCols, head);   // along the snout
    for (let k = 0; k < 2; k++) box(0.035, 0.07, 0.035, CLAW, s * 0.16, -0.14, -0.6 - k * 0.24, head); // fangs
    // horns sweep back and a little outward, in two tapering pieces
    const h1 = fixed(s * 0.16, 0.28, -0.02, head);
    h1.rotation.set(1.0, 0, -s * 0.3);
    box(0.11, 0.3, 0.11, c.horn, 0, 0.14, 0, h1);
    const h2 = fixed(0, 0.28, 0, h1);
    h2.rotation.x = 0.35;
    box(0.07, 0.3, 0.07, shade(c.horn, 0.88), 0, 0.14, 0, h2);
  }
  const jaw = pivot(0, -0.13, -0.18, head);
  box(0.34, 0.14, 0.86, c.body, 0, -0.05, -0.42, jaw);
  box(0.28, 0.02, 0.72, MOUTH, 0, 0.022, -0.44, jaw);
  for (const s of [-1, 1]) for (let k = 0; k < 2; k++) box(0.035, 0.06, 0.035, CLAW, s * 0.14, 0.05, -0.72 + k * 0.24, jaw);
  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = box(0.04, 0.11, 0.15, c.eye, s * 0.25, 0.19, -0.33, head);
    eye.userData.bake = false; // kept separate so it can blink
    box(0.012, 0.1, 0.03, 0x111111, s * 0.022, 0, 0, eye); // slit pupil
    eyes.push(eye);
  }

  // tail: a long tapering chain held out behind (+z), ending in a spade
  const tail = pivot(0, 0.2, 0.32, body);
  const tailSegs = [];
  parent = tail;
  for (let i = 0; i < 8; i++) {
    const seg = pivot(0, 0, i ? 0.42 : 0, parent), w = 0.06 + 0.4 * (1 - i / 8);
    box(w, w * 0.9, 0.46, c.body, 0, 0, 0.21, seg);
    box(0.05, 0.08 + w * 0.2, 0.14, c.spike, 0, w * 0.45 + 0.05, 0.21, seg);
    if (i < 6) for (const s of [-1, 1]) scales(s, w / 2, -w * 0.3, w * 0.3, 0.02, 0.4, 2, 3, scaleCols, seg);
    tailSegs.push(seg);
    parent = seg;
  }
  const spade = fixed(0, 0, 0.55, parent);
  spade.rotation.y = Math.PI / 4;
  box(0.34, 0.04, 0.34, c.wing, 0, 0, 0, spade);

  const wings = [makeDragonWing(-1, body, c), makeDragonWing(1, body, c)];

  bake(root);
  scene.add(root);
  return { root, body, seat, legs, neckSegs, head, jaw, eyes, tail, tailSegs, wings };
}

// One feather lying flat in the wing, rooted at (x, y, z) and pointing `dir` radians back from
// straight out along the span (π/2 points straight back): a vane with a narrower, darker tip and a
// quill down the middle.
function dragonFeather(s, x, y, z, len, w, dir, vane, tip, quill, parent) {
  const f = fixed(x, y, z, parent);
  f.rotation.y = -s * dir;
  box(len * 0.78, 0.024, w, vane, s * len * 0.39, 0, 0, f);
  box(len * 0.24, 0.024, w * 0.72, tip, s * len * 0.88, 0, 0, f);
  box(len * 0.9, 0.034, 0.035, quill, s * len * 0.45, 0.006, 0, f);
}

// Feathered wing (s = -1 left, +1 right). Local frame: span along s*x, feathers trail toward +z.
// Shoulder rotation order YXZ = flap (z), then twist (x), then sweep (y), like the unicorn's wings.
// Layered like a bird's: a row of small scaly coverts along each bone, longer coverts below them,
// then the flight feathers: broad secondaries off the arm and long primaries fanning out from the
// hand, spreading apart into slotted fingers at the tip.
function makeDragonWing(s, parent, c) {
  const A = DRAGON_ARM, H = DRAGON_HAND;
  const vane = [c.wing, shade(c.wing, 0.9)], tip = shade(c.wing, 0.62), quill = shade(c.wing, 1.35);
  const covert = shade(c.wing, 0.8), lesser = shade(c.body, 1.08);
  const shoulder = pivot(s * 0.28, 0.5, -1.0, parent);
  shoulder.rotation.order = 'YXZ';
  box(0.46, 0.2, 0.2, c.body, s * 0.2, 0, 0, shoulder);
  box(A, 0.12, 0.12, c.body, s * A / 2, 0, 0, shoulder);
  const armFeathers = pivot(0, 0, 0, shoulder);
  for (let i = 0; i < 9; i++) {
    const t = i / 8, x = s * (0.12 + t * (A - 0.2));
    dragonFeather(s, x, -0.02 - (i % 2) * 0.012, 0.04, 1.75 - 0.3 * t, 0.3, Math.PI / 2 - 0.1 - 0.25 * t, vane[i % 2], tip, quill, armFeathers);
    dragonFeather(s, x, 0.02, 0.02, 0.8 - 0.1 * t, 0.26, Math.PI / 2 - 0.15 - 0.25 * t, covert, covert, quill, armFeathers);
    if (i < 8) dragonFeather(s, x + s * 0.1, 0.045, 0, 0.38, 0.24, Math.PI / 2 - 0.2, lesser, lesser, lesser, armFeathers);
  }

  const elbow = pivot(s * A, 0, 0, shoulder);
  elbow.rotation.order = 'YXZ';
  box(0.18, 0.18, 0.18, c.body, 0, 0, 0, elbow);
  box(0.07, 0.14, 0.18, CLAW, s * 0.04, 0.11, -0.11, elbow); // thumb claw
  box(H, 0.1, 0.1, c.body, s * H / 2, 0, 0, elbow);
  const fan = pivot(0, 0, 0, elbow);
  for (let i = 0; i < 8; i++) {
    const t = i / 7, x = s * (0.05 + t * (H - 0.05)), dir = 1.3 - 1.2 * t ** 1.2;
    dragonFeather(s, x, -0.02 - (i % 2) * 0.012, 0.03, 1.75 + 0.6 * t, 0.32 - 0.06 * t, dir, vane[i % 2], tip, quill, fan);
    if (i < 7) dragonFeather(s, x, 0.02, 0.02, 0.7 - 0.2 * t, 0.24, dir - 0.05, covert, covert, quill, fan);
  }
  return { shoulder, elbow, armFeathers, fan, s };
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
    // back down to a wingtip beside the tail. The feathers are gathered in toward the bones, so the
    // folded wing drapes down the side as a big feathered cloak.
    w.shoulder.rotation.set(
      open * d.wingAmp * 0.15 * Math.cos(d.wingP) + 0.61 * f,
      s * 0.24 * f,
      s * (open * (d.wingDihedral + d.wingAmp * beat) + 1.4 * f));
    w.elbow.rotation.set(0, -s * 1.71 * f, s * open * d.wingAmp * 0.5 * Math.sin(d.wingP - 0.9));
    w.fan.scale.z = 1 - 0.35 * f;
    w.armFeathers.scale.z = 1 - 0.3 * f;
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
  // ridden, it looks where its rider aims (see aimDragon)
  d.aimW += ((d.rider ? 1 : 0) - d.aimW) * Math.min(1, dt * 6);
  neckYaw += d.aimYaw * d.aimW;
  headUp += d.aimPitch * d.aimW * 0.8; // the neck bends with it, so this tips the head about aimPitch
  // breathing fire (left mouse button held while ridden): jaws open wide
  d.fireW += ((d.breathing && d.rider ? 1 : 0) - d.fireW) * Math.min(1, dt * 8);
  jawOpen = Math.max(jawOpen, 0.6 * d.fireW);

  bob += animateDragonWings(d, dt, takeoffC);

  // apply
  md.body.position.set(0, DRAGON_HIP_Y + bob + Math.sin(state.time * 1.6 + d.breath) * 0.012, 0);
  md.body.rotation.set(pitch, sway, roll);
  barrelRoll(d, dt, md.body, 0.12); // about the middle of the torso
  let neckPitch = 0;
  md.neckSegs.forEach((s, i) => {
    s.rotation.x = DRAGON_NECK_REST[i] + (DRAGON_NECK_FLY[i] - DRAGON_NECK_REST[i]) * d.flyW + headUp * 0.4
      + Math.sin(state.time * 1.3 + d.breath - i * 0.5) * 0.03;
    s.rotation.y = neckYaw / 3 - sway * 0.8;
    neckPitch += s.rotation.x;
  });
  // keep the head roughly level whatever the neck and body are doing; while walking it bobs gently
  // back and forth with each step, less so at a run
  md.head.rotation.x = -(neckPitch + pitch) * 0.8 + headUp;
  md.head.position.z = DRAGON_HEAD_Z + Math.sin(2 * P) * 0.06 * walkAmt * (1 - 0.6 * run);
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
  md.head.localToWorld(d.fireFrom.set(0, -0.08, -1.1)); // kept up to date for aiming, too
  d.fireOn = d.fireW > 0.6;
  if (d.fireOn) breatheFire(d, dt);
  else d.fireAcc = 0;
}

// A roaring stream of flame from the open jaws, where its rider aims, with a little
// smoke. Flames rise as they go, and are thrown along at the dragon's own speed too. Wood and
// leaves the flames reach catch fire.
const FIRE_RATE = 90;  // particles a second
const FIRE_RANGE = 7;  // how far the flames reach, in blocks
const scorchDir = new THREE.Vector3();
function breatheFire(d, dt) {
  const { fireFrom, fireDir } = d, a = d.yaw + d.aimYaw, cp = Math.cos(d.aimPitch);
  fireDir.set(-Math.sin(a) * cp, Math.sin(d.aimPitch), -Math.cos(a) * cp);
  for (let i = 0; d.rider === player && i < 2; i++) { // a couple of rays a frame, spread like the flames (only on the rider's computer)
    scorchDir.set(fireDir.x + rnd(-0.09, 0.09), fireDir.y + rnd(-0.09, 0.09), fireDir.z + rnd(-0.09, 0.09)).normalize();
    scorch(fireFrom, scorchDir, FIRE_RANGE);
  }
  for (d.fireAcc += dt * FIRE_RATE; d.fireAcc >= 1; d.fireAcc--) {
    const sp = rnd(11, 15), smoke = Math.random() < 0.12;
    spawnParticle(fireFrom,
      fireDir.x * sp + d.vel.x + rnd(-1.2, 1.2), fireDir.y * sp + d.vel.y + rnd(-1.2, 1.2), fireDir.z * sp + d.vel.z + rnd(-1.2, 1.2),
      smoke ? 0x6e6e6e : FIRE_COLORS[Math.floor(Math.random() * FIRE_COLORS.length)],
      rnd(0.4, 0.7), smoke ? -2.5 : -1.5, rnd(2.2, 3.8));
  }
}

// Aiming: the rider's crosshair, looking from `eye` along `dir`. The dragon turns its neck and head
// toward whatever the crosshair is on (a block, or another dragon close to it, so a moving one is
// easier to hit) and its flames go straight there. While breathing, it swings its body round to
// face its target too. aimYaw is from the way it faces, aimPitch up or down from level;
// they're sent to the other players with the rest, so they see the flames go the same way.
const AIM_RANGE = 40;                            // blocks
const AIM_YAW = 1, AIM_UP = 0.7, AIM_DOWN = -1.1; // how far the neck turns, in radians
const AIM_ASSIST = 0.12;                         // radians off the crosshair a dragon still counts as aimed at
const aimAt = new THREE.Vector3();
export function aimDragon(d, eye, dir, dt) {
  const hit = raycast(eye, dir, AIM_RANGE);
  let dist = AIM_RANGE, onSomething = !!hit;
  if (hit) { aimAt.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5); dist = aimAt.distanceTo(eye); }
  else aimAt.copy(eye).addScaledVector(dir, AIM_RANGE);
  for (const o of dragons) {
    if (o === d) continue;
    tmp.set(o.pos.x, o.pos.y + o.baseH / 2, o.pos.z).sub(eye);
    const t = tmp.dot(dir);
    if (t > 0 && t < dist && tmp.angleTo(dir) < AIM_ASSIST) { dist = t; aimAt.copy(tmp).add(eye); onSomething = true; }
  }
  tmp.subVectors(aimAt, d.fireFrom);
  const yaw = wrapAngle(Math.atan2(-tmp.x, -tmp.z) - d.yaw), pitch = Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z));
  d.aimYaw = clamp(yaw, -AIM_YAW, AIM_YAW);
  d.aimPitch = clamp(pitch, AIM_DOWN, AIM_UP);
  // breathing, it swings round to face its target: quickly if that's past where its neck reaches
  if (d.breathing) d.yaw += (yaw - d.aimYaw) * Math.min(1, dt * 5) + d.aimYaw * Math.min(1, dt * 2);
  // close enough for the flames to reach it (shown by the crosshair, see hud.js)
  d.aimInRange = onSomething && tmp.length() < d.breathRange + 1 && pitch === d.aimPitch;
}

// Health: fire costs a dragon a heart, at most one every HURT_COOLDOWN seconds, whether it's another
// dragon's breath or burning blocks it flies or walks through; so do another dragon's bubbles. Out of hearts, it throws its rider
// off (see controls.js) and can't be ridden until it has healed a heart. Left alone it heals.
// A dragon in a barrel roll spins clear of the flames and isn't hurt. Playing together, the
// computer running the dragon decides, and sends its health with the rest.
export const DRAGON_HEARTS = 10;
const HURT_COOLDOWN = 1, HEAL_DELAY = 8, HEAL_TIME = 3; // seconds
const HIT_RADIUS = 1.5; // around the dragon's middle, for breath; it widens along the flames
const hitV = new THREE.Vector3();
function inFire(d) {
  tmp.set(d.pos.x, d.pos.y + d.baseH / 2, d.pos.z);
  for (const o of dragons) {
    if (o === d || !o.fireOn) continue;
    const v = hitV.subVectors(tmp, o.fireFrom), t = v.dot(o.fireDir), r = HIT_RADIUS + t * 0.15;
    if (t > 0 && t < FIRE_RANGE + HIT_RADIUS && v.lengthSq() - t * t < r * r) return true;
  }
  const x = d.pos.x, z = d.pos.z;
  return fireIn(Math.floor(x - 1.5), Math.floor(d.pos.y - 0.5), Math.floor(z - 1.5), Math.floor(x + 1.5), Math.floor(d.pos.y + d.h), Math.floor(z + 1.5));
}
function hurt(d, dt, bubbled) {
  d.hurtCd -= dt;
  if (d.hurtCd <= 0 && d.health > 0 && !d.roll && (bubbled || inFire(d))) {
    d.health--;
    d.hurtCd = HURT_COOLDOWN; d.healT = HEAL_DELAY;
  } else if (d.health < DRAGON_HEARTS && (d.healT -= dt) <= 0) {
    d.health++; d.healT = HEAL_TIME;
  }
}

// Barrel rolls have a cooldown once they finish, which grows the more the dragon spins: each roll
// adds one to its dizziness, which wears off by one every DIZZY_TIME seconds, and the cooldown is
// ROLL_COOLDOWN seconds for each.
const ROLL_COOLDOWN = 0.6, DIZZY_TIME = 4;
function rollCooldown(d, dt) {
  if (d.roll && !d.rollCounted) { d.dizzy++; d.rollCd = ROLL_COOLDOWN * d.dizzy; }
  d.rollCounted = !!d.roll;
  if (!d.roll) d.rollCd = Math.max(0, d.rollCd - dt);
  d.dizzy = Math.max(0, d.dizzy - dt / DIZZY_TIME);
}

// Bubbles' legs are too short to walk on (see potato.js), so it gets about in hops: it sits a moment
// each time it lands, then springs off the way it's going and sails along through the air.
const HOP_UP = 6.5, HOP_REST = 0.12;
function hop(d, tx, tz, dt) {
  if (!d.onGround) { d.hopCd = HOP_REST; return accelerate(d, tx, tz, dt, 1.5); }
  d.hopCd -= dt;
  if ((tx || tz) && d.hopCd <= 0) d.vel.set(tx, d.hitWall ? 9 : HOP_UP, tz); // a big hop up onto a block
  else accelerate(d, 0, 0, dt);
}

const DRAGON_HOME_RADIUS = 55; // flying dragons turn back toward the island past this
export function updateDragon(d, dt) {
  d.aiTimer -= dt;
  d.turnCd -= dt;
  d.stateT += dt;
  const gx = Math.floor(d.pos.x), gz = Math.floor(d.pos.z);
  d.groundY = Math.max(columnTop(gx, gz), WATER) + 1;
  const setState = (s, t) => { d.state = s; d.stateT = 0; d.aiTimer = t; };

  if (d.rider || d.remote) {
    // steered by its rider (see rideDragon), or run on another computer (see multiplayer.js)
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
    if (d.hops) hop(d, tx, tz, dt);
    else accelerate(d, tx, tz, dt, 3);
    d.glide = false;
    physics(d, dt);
  }

  // bubbles pop on it wherever it runs, but only the computer running it decides it's hurt
  tmp.set(d.pos.x, d.pos.y + d.baseH / 2, d.pos.z);
  const bubbled = popBubblesNear(tmp, d.hw + 0.7, d) > 0;
  if (!d.remote) { rollCooldown(d, dt); hurt(d, dt, bubbled); }
  d.animate(d, dt);
  // it screeches as it starts a barrel roll, and as it's hurt unless it's mid-roll and already
  // screeching (wherever it runs: elsewhere its health comes in with its updates)
  if (d.roll && !d.screeched) screech(d);
  d.screeched = !!d.roll;
  if (d.health < d.heardHealth && !d.roll) screech(d);
  d.heardHealth = d.health;
  const tagDist = d.pos.distanceTo(player.pos);
  d.tag.visible = !d.rider && tagDist > 4 && tagDist < 20;
}

// Riding a dragon: run on the ground, Space to take off and climb, Shift to dive. With neither
// held it keeps its height, hovering when slow. Coming down onto the ground lands it.
const DRAGON_RUN_SPEED = 6;
export function rideDragon(d, dt, mx, mz, back, space, shift) {
  const len = Math.hypot(mx, mz);
  d.glide = false;
  if (d.state === 'fly') {
    if (len > 0) d.yaw = lerpAngle(d.yaw, Math.atan2(-mx, -mz), dt * 4);
    const sp = d.flySpeed * (back ? 0.5 : 1);
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
  if (d.hops && d.state !== 'takeoff') hop(d, mx * sp, mz * sp, dt);
  else accelerate(d, mx * sp, mz * sp, dt, 3);
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
// The big winged T-rex dragons. Other sorts of dragon (see potato.js) pass `kind` to change any of
// these: how it's built and animated, its size, speed, weapon and voice, and whether it hops.
const T_REX = {
  makeModel: makeDragonModel, animate: animateDragon, hw: 0.6, h: 2.3, riddenH: 3.4, seatRestY: DRAGON_HIP_Y + 0.68,
  tagY: 3.6, walkSpeed: 1.8, flySpeed: 13, hops: false, breathRange: FIRE_RANGE, weapon: 'breathe fire', voice: 1,
};
export function makeDragon(c, p, kind = {}) {
  const k = { ...T_REX, ...kind };
  const d = new Entity(k.hw, k.h);
  Object.assign(d, {
    kind: 'dragon', name: c.name, label: c.label || `${c.name} the Dragon`, model: k.makeModel(c), animate: k.animate,
    walkSpeed: k.walkSpeed, flySpeed: k.flySpeed, hops: k.hops, hopCd: 0, breathRange: k.breathRange, weapon: k.weapon, voice: k.voice,
    rider: null, baseH: k.h, riddenH: k.riddenH, seatRestY: k.seatRestY, seatWorld: new THREE.Vector3(),
    state: 'idle', stateT: 0, aiTimer: 1 + rand() * 3, turnCd: 0, stuckT: 0, cruise: 12, groundY: p.y,
    phase: 0, flyW: 0, reachW: 0, fvy: 0, landT: 0, turn: 0, idle: null, idleT: 0, idleCd: 2 + Math.random() * 4, lookTo: 0,
    blinkT: Math.random() * 4, breath: Math.random() * 6, glideT: 0, flapping: false,
    wingFold: 1, wingAmp: 0, wingFreq: 1, wingDihedral: 0.12, wingP: 0, roll: null, barrel: 0,
    breathing: false, fireW: 0, fireAcc: 0, fireOn: false, fireFrom: new THREE.Vector3(), fireDir: new THREE.Vector3(),
    aimYaw: 0, aimPitch: 0, aimW: 0, aimInRange: false,
    health: DRAGON_HEARTS, hurtCd: 0, healT: 0, rollCd: 0, dizzy: 0, rollCounted: false,
  });
  d.pos.copy(p);
  d.yaw = d.wanderYaw = d.prevYaw = rand() * Math.PI * 2;
  d.tag = nameTag('🐉 ' + c.name);
  d.tag.position.set(0, k.tagY, 0);
  d.model.root.add(d.tag);
  dragons.push(d);
  return d;
}
