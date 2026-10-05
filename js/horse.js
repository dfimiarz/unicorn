import * as THREE from 'three';
import { WATER } from './config.js';
import { clamp, wrapAngle, lerpAngle, rnd } from './util.js';
import { hash2 } from './noise.js';
import { RAINBOW_HEX } from './blocks.js';
import { rand, columnTop } from './world.js';
import { scene } from './render.js';
import { Entity, physics, accelerate, ledgeJump } from './physics.js';
import { box, pivot, fixed, shade, bake, nameTag, LEATHER, GOLD } from './modelkit.js';
import { spawnParticle } from './particles.js';
import { player } from './player.js';
import { state } from './state.js';

// Horses and unicorns: the model, the animation, and how they wander about.

// ---------------------------------------------------------------- horse model
// Horse rig: root (position + yaw) → body pivot at the hind hips (bob, pitch, lean, rearing)
// → two-segment legs, neck → head, jointed tail. Leg order is FL, FR, HL, HR.
const HIP_Y = 0.8, SEAT_REST_Y = HIP_Y + 0.68;
const STEEL = 0xb8bcc4, SOCK = 0xf4f1ea;
function makeHorseModel(c, unicorn) {
  const root = new THREE.Group();
  const body = pivot(0, HIP_Y, 0.55, root);
  const hoof = unicorn ? 0xd9b3ff : 0x3a2a1e;
  const saddle = unicorn ? 0xff6fb5 : 0x6b3a1e, strap = unicorn ? 0xff9ad5 : LEATHER;
  const metal = unicorn ? GOLD : STEEL, trim = unicorn ? GOLD : 0xf0e6d0;
  const legs = [];
  [[-0.2, -1.05, false], [0.2, -1.05, false], [-0.2, 0, true], [0.2, 0, true]].forEach(([x, z, hind], i) => {
    const hip = pivot(x, 0, z, body);
    box(0.2, 0.42, hind ? 0.26 : 0.2, c.body, 0, -0.19, 0, hip);
    box(0.22, 0.16, hind ? 0.3 : 0.22, c.body, 0, -0.07, 0, hip); // forearm / gaskin muscle
    const knee = pivot(0, -0.38, 0, hip);
    const lower = c.socks?.includes(i) ? SOCK : c.points ? c.mane : c.body;
    box(0.15, 0.28, 0.15, lower, 0, -0.14, 0, knee);
    if (hind) box(0.11, 0.1, 0.07, lower, 0, -0.05, 0.09, knee); // point of the hock
    else box(0.16, 0.1, 0.05, lower, 0, -0.05, -0.07, knee);     // knee
    box(0.17, 0.07, 0.17, lower, 0, -0.235, 0, knee);            // fetlock
    if (unicorn) {
      // silky feathering around the fetlocks
      box(0.2, 0.08, 0.2, 0xf3e8ff, 0, -0.24, 0.01, knee);
      box(0.12, 0.08, 0.06, 0xe0ccff, 0, -0.27, 0.1, knee);
    }
    box(0.19, 0.03, 0.19, unicorn ? GOLD : shade(hoof, 1.25), 0, -0.295, 0, knee); // coronet
    box(0.18, 0.14, 0.18, hoof, 0, -0.35, 0, knee);
    box(0.185, 0.025, 0.185, shade(hoof, 0.7), 0, -0.405, 0, knee);
    legs.push({ hip, knee, hind });
  });

  // barrel, with a deeper chest, rounded hindquarters, withers and croup, and a darker belly
  box(0.6, 0.62, 1.4, c.body, 0, 0.3, -0.55, body);
  box(0.52, 0.48, 0.12, c.body, 0, 0.27, -1.29, body);
  box(0.5, 0.44, 0.08, c.body, 0, 0.33, 0.18, body);
  box(0.56, 0.1, 0.34, c.body, 0, 0.64, 0, body);
  box(0.34, 0.08, 0.3, c.body, 0, 0.64, -1.07, body);
  box(0.52, 0.06, 1.0, shade(c.body, 0.82), 0, -0.03, -0.6, body);
  if (c.dorsal) {
    box(0.06, 0.01, 0.34, c.mane, 0, 0.695, 0, body);
    box(0.06, 0.01, 0.3, c.mane, 0, 0.685, -1.07, body);
  }
  if (c.dapples) {
    for (const s of [-1, 1]) for (let i = 0; i < 22; i++) {
      const y = 0.05 + hash2(i, s) * 0.5, z = -1.2 + hash2(s, i + 50) * 1.3;
      if (y > 0.3 && z > -0.86 && z < -0.14) continue; // under the saddle cloth
      box(0.012, 0.07, 0.08, shade(c.body, 1.25), s * 0.302, y, z, body);
    }
  }

  // tack: saddle cloth with a trim, girth, saddle with pommel and cantle, stirrups
  box(0.62, 0.3, 0.66, c.pad, 0, 0.47, -0.5, body);
  box(0.63, 0.03, 0.67, trim, 0, 0.335, -0.5, body);
  box(0.615, 0.71, 0.07, shade(saddle, 0.7), 0, 0.285, -0.72, body);
  box(0.66, 0.2, 0.36, shade(saddle, 0.85), 0, 0.52, -0.5, body);
  box(0.64, 0.08, 0.5, saddle, 0, 0.64, -0.5, body);
  box(0.3, 0.1, 0.1, saddle, 0, 0.71, -0.72, body);
  box(0.31, 0.03, 0.11, metal, 0, 0.75, -0.72, body);
  box(0.42, 0.12, 0.08, saddle, 0, 0.72, -0.29, body);
  for (const s of [-1, 1]) {
    box(0.04, 0.28, 0.04, strap, s * 0.345, 0.48, -0.5, body);
    if (unicorn) continue; // the folded wings cover where the irons would hang
    box(0.08, 0.025, 0.13, metal, s * 0.355, 0.27, -0.5, body);
    for (const dz of [-0.055, 0.055]) box(0.08, 0.08, 0.02, metal, s * 0.355, 0.305, -0.5 + dz, body);
  }
  const seat = pivot(0, 0.68, -0.55, body);

  const neck = pivot(0, 0.45, -1.1, body);
  neck.rotation.order = 'YXZ';
  neck.rotation.x = -0.5;
  box(0.3, 0.8, 0.42, c.body, 0, 0.35, -0.05, neck);
  box(0.34, 0.3, 0.46, c.body, 0, 0.05, -0.04, neck); // thicker where it meets the shoulders
  if (unicorn) {
    RAINBOW_HEX.forEach((col, i) => {
      const y = 0.72 - i * 0.14;
      box(0.13, 0.16, 0.14, col, 0, y, 0.2, neck);
      box(0.08, 0.08, 0.08, shade(col, 1.45), 0, y + 0.04, 0.29, neck);  // pastel tuft
      box(0.04, 0.24, 0.1, shade(col, 1.2), 0.165, y - 0.07, 0.13, neck); // strands falling to one side
    });
  } else {
    // a crest of alternating tufts, with longer locks falling down one side of the neck
    box(0.1, 0.82, 0.08, c.mane, 0, 0.37, 0.19, neck);
    for (let i = 0; i < 8; i++) {
      const y = 0.75 - i * 0.105, alt = i % 2, k = i % 3;
      box(0.12, 0.1, 0.1 + alt * 0.04, alt ? shade(c.mane, 1.18) : c.mane, 0, y, 0.22 + alt * 0.02, neck);
      box(0.035, 0.12 + k * 0.04, 0.09, k ? c.mane : shade(c.mane, 0.75), 0.165, y - 0.06 - k * 0.02, 0.12, neck);
    }
  }
  // reins run from the bit back along the neck
  for (const s of [-1, 1]) box(0.014, 0.89, 0.025, strap, s * 0.17, 0.41, -0.22, neck).rotation.x = -0.865;

  const head = pivot(0, 0.75, -0.05, neck);
  head.rotation.x = 0.1;
  box(0.32, 0.3, 0.42, c.body, 0, 0, -0.1, head);
  box(0.26, 0.24, 0.36, c.body, 0, -0.04, -0.45, head);
  box(0.3, 0.12, 0.2, c.body, 0, -0.16, 0, head);  // jaw
  box(0.33, 0.04, 0.1, c.body, 0, 0.1, -0.12, head); // brow
  const nose = unicorn || c.coat === 'White' ? 0xe8b9c8 : shade(c.body, 0.6);
  box(0.27, 0.13, 0.1, nose, 0, -0.095, -0.59, head);
  box(0.275, 0.012, 0.08, shade(nose, 0.6), 0, -0.125, -0.6, head); // mouth
  for (const s of [-1, 1]) box(0.05, 0.04, 0.02, 0x1a1210, s * 0.07, -0.06, -0.645, head); // nostrils
  if (c.face) {
    box(0.08, 0.02, c.face === 'blaze' ? 0.18 : 0.08, SOCK, 0, 0.155, -0.2, head);
    if (c.face === 'blaze') {
      box(0.07, 0.02, 0.3, SOCK, 0, 0.085, -0.45, head);
      box(0.07, 0.1, 0.012, SOCK, 0, 0.03, -0.632, head);
    }
  }
  const eyes = [], ears = [];
  for (const s of [-1, 1]) {
    const eye = box(0.04, 0.07, 0.08, unicorn ? 0x2b1747 : 0x111111, s * 0.165, 0.04, -0.12, head);
    eye.userData.bake = false; // kept separate so it can blink
    box(0.01, 0.022, 0.022, 0xffffff, s * 0.02, 0.016, -0.02, eye); // glint
    eyes.push(eye);
    if (unicorn) for (let k = 0; k < 3; k++) box(0.012, 0.045, 0.014, 0x222222, s * 0.187, 0.085, -0.15 + k * 0.03, head);
    const ear = pivot(s * 0.1, 0.14, 0.06, head);
    box(0.07, 0.14, 0.05, c.body, 0, 0.07, 0, ear);
    box(0.045, 0.05, 0.035, c.points ? c.mane : c.body, 0, 0.16, 0, ear);
    box(0.04, 0.09, 0.012, unicorn ? 0xffb3d1 : shade(c.body, 0.55), 0, 0.065, -0.027, ear);
    ears.push(ear);
  }
  // bridle: noseband, headpiece, cheek straps and bit rings
  box(0.275, 0.28, 0.04, strap, 0, -0.04, -0.42, head);
  box(0.335, 0.32, 0.04, strap, 0, 0, 0.02, head);
  for (const s of [-1, 1]) {
    box(0.012, 0.035, 0.33, strap, s * 0.166, -0.03, -0.14, head);
    box(0.012, 0.035, 0.12, strap, s * 0.136, -0.03, -0.36, head);
    box(0.03, 0.06, 0.06, metal, s * 0.14, -0.1, -0.5, head);
  }
  let horn = null;
  if (unicorn) {
    horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.45, 8), new THREE.MeshLambertMaterial({ color: 0xffd86b, emissive: 0x664400 }));
    horn.position.set(0, 0.33, -0.18);
    horn.rotation.x = -0.3;
    horn.castShadow = true;
    head.add(horn);
    // a groove spiralling up the horn, and a gold band at its base
    for (let k = 0; k < 16; k++) {
      const t = k / 16, y = -0.2 + t * 0.36, r = 0.06 * (0.225 - y) / 0.45, a = t * Math.PI * 6, sz = 0.028 - t * 0.014;
      box(sz, 0.022, sz, 0xfff4c2, Math.cos(a) * r, y, Math.sin(a) * r, horn);
    }
    box(0.13, 0.03, 0.13, GOLD, 0, -0.21, 0, horn);
    box(0.16, 0.08, 0.12, 0xff9ad5, 0, 0.17, -0.02, head);
    for (const s of [-1, 1]) box(0.05, 0.03, 0.18, s < 0 ? 0xffb3c6 : 0xbdb2ff, s * 0.085, 0.16, -0.16, head);
  } else {
    // forelock
    box(0.12, 0.08, 0.06, c.mane, 0, 0.19, 0.03, head);
    box(0.11, 0.03, 0.14, shade(c.mane, 1.12), 0, 0.165, -0.04, head);
  }

  // tail is a chain of segments so it can swish and stream behind
  const tail = pivot(0, 0.5, 0.15, body);
  tail.rotation.x = -0.5;
  box(0.13, 0.12, 0.13, c.body, 0, -0.02, 0, tail); // dock
  const tailSegs = [];
  const segCount = unicorn ? 6 : 4, segLen = unicorn ? 0.14 : 0.2;
  let parent = tail;
  for (let i = 0; i < segCount; i++) {
    const seg = pivot(0, i ? -segLen : 0, 0, parent);
    const w = unicorn ? 0.15 : 0.14 - i * 0.012, col = unicorn ? RAINBOW_HEX[i] : c.mane;
    box(w, segLen + 0.03, w, col, 0, -segLen / 2, 0, seg);
    // loose strands around the core give the tail some volume
    box(w * 0.45, segLen + 0.06, w * 0.45, shade(col, 0.78), w * 0.38, -segLen / 2 - 0.02, w * 0.3, seg);
    box(w * 0.45, segLen + 0.05, w * 0.45, shade(col, 1.2), -w * 0.36, -segLen / 2 - 0.015, -w * 0.28, seg);
    if (i === segCount - 1) box(w * 0.8, 0.08, w * 0.8, shade(col, 1.25), 0, -segLen - 0.03, 0, seg);
    tailSegs.push(seg);
    parent = seg;
  }

  const wings = unicorn ? [makeWing(-1, body), makeWing(1, body)] : null;

  bake(root);
  scene.add(root);
  return { root, body, legs, seat, neck, head, eyes, ears, tail, tailSegs, horn, wings };
}

// Feathered wing (s = -1 left, +1 right). Local frame: span along s*x, feathers trail toward +z.
// Shoulder rotation order YXZ = flap (z), then twist along the span (x), then sweep back (y).
// The elbow (hand section) lags behind the shoulder when flapping, for a whip-like wingbeat.
// Layered like a bird's wing: a rounded leading edge, rows of coverts on top and underneath, and
// flight feathers with gold quills whose pastel tips run through the rainbow out to the wingtip.
const WING_TIPS = [0xffb3c6, 0xffd6a5, 0xfdffb6, 0xcaffbf, 0x9bf6ff, 0xbdb2ff];
const WING_WHITE = 0xffffff, WING_SOFT = 0xf1ecfb, WING_PEARL = 0xe4daf6, WING_QUILL = 0xf0d890;
function wingTip(t) {
  const f = t * (WING_TIPS.length - 1), i = Math.min(WING_TIPS.length - 2, Math.floor(f));
  return new THREE.Color(WING_TIPS[i]).lerp(new THREE.Color(WING_TIPS[i + 1]), f - i).getHex();
}
// one flight feather rooted at (x, y, z), angled `a` radians off straight back
function feather(x, y, z, len, w, a, tip, parent) {
  const f = fixed(x, y, z, parent);
  f.rotation.y = a;
  box(w, 0.026, len * 0.7, WING_SOFT, 0, 0, len * 0.35, f);
  box(w * 0.85, 0.024, len * 0.26, tip, 0, 0, len * 0.82, f);
  box(w * 0.45, 0.022, len * 0.08, shade(tip, 0.9), 0, 0, len * 0.97, f);
  box(0.012, 0.034, len * 0.92, WING_QUILL, 0, 0.004, len * 0.46, f);
}
// a row of n overlapping covert feathers spanning x0..x1, each with a rounded tip
function covertRow(s, x0, x1, n, y, z, d, colA, colB, parent) {
  const step = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const x = s * (x0 + (i + 0.5) * step), yy = y + (i % 2) * 0.004, col = i % 2 ? colA : colB;
    box(step + 0.02, 0.03, d, col, x, yy, z, parent);
    box(step * 0.6, 0.026, 0.04, col, x, yy, z + d / 2 + 0.015, parent);
  }
}
function makeWing(s, parent) {
  const shoulder = pivot(s * 0.33, 0.55, -1.08, parent);
  shoulder.rotation.order = 'YXZ';
  // arm: leading edge, lesser and greater coverts (plus a row underneath), six secondaries
  box(0.5, 0.075, 0.09, WING_WHITE, s * 0.25, 0.012, 0, shoulder);
  covertRow(s, 0, 0.5, 5, 0.018, 0.09, 0.1, WING_WHITE, WING_SOFT, shoulder);
  covertRow(s, 0, 0.5, 4, 0.01, 0.18, 0.12, WING_SOFT, WING_PEARL, shoulder);
  covertRow(s, 0, 0.5, 4, -0.026, 0.12, 0.2, WING_PEARL, WING_SOFT, shoulder);
  for (let i = 0; i < 6; i++) {
    feather(s * (0.04 + i * 0.085), -0.006 - (i % 2) * 0.006, 0.16, 0.42 + (i % 2) * 0.03, 0.095, s * 0.03 * (i - 2), wingTip(i / 12), shoulder);
  }
  // hand: leading edge, coverts, the little alula at the wrist, seven primaries fanning out to the tip
  const elbow = pivot(s * 0.5, 0.02, 0, shoulder);
  elbow.rotation.order = 'YXZ';
  box(0.44, 0.065, 0.08, WING_WHITE, s * 0.21, 0.008, 0, elbow);
  covertRow(s, 0, 0.42, 4, 0.016, 0.08, 0.1, WING_WHITE, WING_SOFT, elbow);
  covertRow(s, 0, 0.42, 4, 0.008, 0.17, 0.11, WING_SOFT, WING_PEARL, elbow);
  covertRow(s, 0, 0.42, 3, -0.024, 0.11, 0.18, WING_PEARL, WING_SOFT, elbow);
  for (let i = 0; i < 2; i++) feather(s * 0.03, 0.045, 0.02, 0.16 - i * 0.03, 0.05, s * (1.9 + i * 0.25), WING_PEARL, elbow);
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    feather(s * (0.06 + t * 0.36), -0.006 - (i % 2) * 0.006, 0.18 - t * 0.12, 0.48 + t * 0.12, 0.1, s * 1.05 * t ** 1.6, wingTip((6 + i) / 12), elbow);
  }
  return { shoulder, elbow, s };
}

// ---------------------------------------------------------------- horse animation
// Each gait: per-leg footfall offsets (FL, FR, HL, HR), fraction of the stride a hoof is planted,
// stride length in blocks, how far legs swing, and how high knees fold on the way forward.
const GAITS = {
  walk:   { offs: [0.25, 0.75, 0, 0.5], duty: 0.65, stride: 1.5, reach: 0.35, lift: 0.8 },
  trot:   { offs: [0, 0.5, 0.5, 0],     duty: 0.45, stride: 2.2, reach: 0.45, lift: 1.2 },
  gallop: { offs: [0.55, 0.65, 0, 0.12], duty: 0.35, stride: 3.6, reach: 0.7, lift: 1.5 },
};
const GAIT_NAMES = ['walk', 'trot', 'gallop'];
export const REAR_TIME = 1.2;
const IDLE_TIME = { toss: 0.8, paw: 1.4, shake: 0.7, stretch: 2.4 };
const legPoseOut = [0, 0];

function legPose(q, g, hind) {
  if (q < g.duty) {
    // planted: the hoof stays put while the body moves over it, so the leg sweeps front to back
    legPoseOut[0] = g.reach * (1 - 2 * q / g.duty);
    legPoseOut[1] = 0;
  } else {
    // swinging forward: knee folds up then straightens to reach for the ground
    const s = (q - g.duty) / (1 - g.duty);
    const flex = Math.sin(Math.PI * s) * g.lift;
    legPoseOut[0] = -g.reach + 2 * g.reach * (1 - Math.cos(Math.PI * s)) / 2 + (hind ? -0.15 : 0.25) * flex;
    legPoseOut[1] = hind ? flex * 0.8 : -flex;
  }
  return legPoseOut;
}
const lerpArr = (a, b, t) => { for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * t; };

// Wings: folded on the ground, big strokes when climbing, held out to glide, swept back in a dive.
// Returns a small body bob that goes with each wingbeat.
function animateWings(m, dt, flying, jumping) {
  let fold = 1, amp = 0, freq = 1, dihedral = 0.1;
  if (flying) {
    fold = 0;
    if (m.vel.y > 1) { amp = 0.85; freq = 3.2; }            // climbing: powerful flaps
    else if (m.vel.y < -5) { fold = 0.45; amp = 0.05; freq = 2; } // diving: swept back
    else { amp = 0.1; freq = 1.1; dihedral = 0.28; }         // gliding: wings held up and out
  } else if (jumping || m.rearT > 0) { fold = 0.15; amp = 0.6; freq = 3; }
  else if (m.idle && m.idle.type === 'stretch') {
    const s = m.idle.t / IDLE_TIME.stretch;
    fold = 1 - Math.sin(Math.PI * Math.min(1, s)); amp = 0.35; freq = 0.9;
  } else if (m.gw.gallop > 0.5 && Math.hypot(m.vel.x, m.vel.z) > 3) { fold = 0.8; amp = 0.15; freq = 2.5; }
  const k = Math.min(1, dt * 6);
  m.wingFold += (fold - m.wingFold) * k;
  m.wingAmp += (amp - m.wingAmp) * k;
  m.wingFreq += (freq - m.wingFreq) * k;
  m.wingDihedral += (dihedral - m.wingDihedral) * k;
  m.wingP += dt * m.wingFreq * Math.PI * 2;
  const f = m.wingFold, open = 1 - f, beat = Math.sin(m.wingP);
  for (const w of m.model.wings) {
    const s = w.s;
    // folded: swept straight back, feathers hanging down the flank, tip lifted slightly
    w.shoulder.rotation.set(1.82 * f, -s * (0.15 + 1.35 * f), s * (open * (m.wingDihedral + m.wingAmp * beat) + 0.2 * f));
    w.elbow.rotation.set(0, 0, s * open * m.wingAmp * 0.6 * Math.sin(m.wingP - 0.9));
  }
  return -beat * 0.05 * m.wingAmp * open;
}

function animateHorse(m, dt) {
  const md = m.model;
  const hs = Math.hypot(m.vel.x, m.vel.z);
  const move = Math.min(1, hs / 0.8);
  const prevAir = m.airTime;
  m.airTime = m.onGround || m.inWater ? 0 : m.airTime + dt;
  if (m.airTime === 0 && prevAir > 0.25) m.landT = 1;
  const flying = m.kind === 'unicorn' && m.airTime > 0.25;

  // blend smoothly between gaits as speed changes (bigger animals switch gait at higher speeds,
  // and take longer strides)
  const gs = hs / m.pace;
  const target = flying ? 'gallop' : gs < 2.8 ? 'walk' : gs < 5.8 ? 'trot' : 'gallop';
  let stride = 0;
  for (const g of GAIT_NAMES) {
    m.gw[g] += ((g === target ? 1 : 0) - m.gw[g]) * Math.min(1, dt * 5);
    stride += m.gw[g] * GAITS[g].stride * m.size;
  }
  m.phase = (m.phase + dt * (flying ? 2.2 / m.pace : hs / stride)) % 1;

  const hip = [0, 0, 0, 0], knee = [0, 0, 0, 0];
  for (const g of GAIT_NAMES) {
    const w = m.gw[g];
    if (w < 0.001) continue;
    const G = GAITS[g];
    for (let i = 0; i < 4; i++) {
      const p = legPose((m.phase - G.offs[i] + 1) % 1, G, i >= 2);
      hip[i] += p[0] * w; knee[i] += p[1] * w;
    }
  }
  const legAmt = flying ? 0.6 : move;
  for (let i = 0; i < 4; i++) { hip[i] *= legAmt; knee[i] *= legAmt; }

  // body bob / rocking and head nod for each gait
  const P = m.phase * Math.PI * 2, gw = m.gw;
  let bob = (gw.walk * 0.025 * Math.cos(2 * P) + gw.trot * 0.05 * Math.cos(2 * P) + gw.gallop * 0.07 * Math.sin(P)) * legAmt;
  let pitch = gw.gallop * 0.1 * Math.sin(P - 0.6) * legAmt;
  let neckX = -0.5 - (0.1 * gw.trot + 0.35 * gw.gallop) * move
    + (gw.walk * 0.08 * Math.sin(2 * P) - gw.gallop * 0.22 * Math.sin(P - 0.6)) * legAmt;
  let neckY = 0, headX = 0.1;

  // jumping: tuck front legs on the way up, reach for the ground on the way down
  const jumping = !m.onGround && !m.inWater && m.airTime > 0.08 && !flying;
  m.airW += ((jumping ? 1 : 0) - m.airW) * Math.min(1, dt * 10);
  if (m.airW > 0.001) {
    const up = clamp(m.vel.y / 6, -1, 1) * 0.5 + 0.5;
    const aHip = [0.5 + 0.4 * up, 0.5 + 0.4 * up, 0.3 - 0.9 * up, 0.3 - 0.9 * up];
    const aKnee = [-0.3 - 1.3 * up, -0.3 - 1.3 * up, 0.7 - 0.4 * up, 0.7 - 0.4 * up];
    lerpArr(hip, aHip, m.airW); lerpArr(knee, aKnee, m.airW);
    pitch += (-0.15 + 0.4 * up) * m.airW;
    neckX += (0.1 - 0.3 * up) * m.airW;
  }
  if (flying) {
    pitch += clamp(m.vel.y * 0.04, -0.3, 0.3);
    knee[0] -= 0.5; knee[1] -= 0.5; knee[2] += 0.3; knee[3] += 0.3;
  }

  // landing squash
  m.landT = Math.max(0, m.landT - dt * 4);
  bob -= 0.09 * m.landT; pitch -= 0.06 * m.landT;
  knee[0] -= 0.4 * m.landT; knee[1] -= 0.4 * m.landT; knee[2] += 0.4 * m.landT; knee[3] += 0.4 * m.landT;

  // idle fidgets: head toss, pawing the ground, head shake, the odd rear
  m.idleCd -= dt;
  if (!m.idle && m.idleCd <= 0 && hs < 0.3 && m.onGround && m.rearT <= 0 && m.state !== 'graze') {
    const r = Math.random();
    if (r < 0.1 && !m.rider) m.rearT = REAR_TIME;
    else if (r < 0.35 && m.kind === 'unicorn') m.idle = { type: 'stretch', t: 0 };
    else m.idle = { type: r < 0.55 ? 'toss' : r < 0.85 ? 'paw' : 'shake', t: 0 };
    m.idleCd = 3 + Math.random() * 5;
  }
  if (m.idle) {
    const I = m.idle;
    I.t += dt;
    const s = I.t / IDLE_TIME[I.type], env = Math.sin(Math.PI * Math.min(1, s));
    if (I.type === 'toss') { neckX += 0.45 * env; headX -= 0.35 * Math.sin(2 * Math.PI * s) * env; }
    else if (I.type === 'paw') { hip[1] += (0.45 + 0.35 * Math.sin(s * Math.PI * 6)) * env; knee[1] -= 1.3 * env; }
    else if (I.type === 'shake') neckY += Math.sin(I.t * 22) * 0.25 * env;
    else { neckX += 0.25 * env; } // stretch: head up while the wings open (see wings below)
    if (s >= 1 || hs > 0.5) m.idle = null;
  }

  // grazing: lower the head and chew
  m.grazeW += ((m.state === 'graze' && !m.rider && hs < 0.5 ? 1 : 0) - m.grazeW) * Math.min(1, dt * 2.5);
  neckX += (-2.1 - neckX) * m.grazeW;
  headX += Math.sin(state.time * 9) * 0.07 * m.grazeW;

  // rearing up on the hind legs (when you climb on, and now and then on its own)
  m.rearR = 0;
  if (m.rearT > 0) {
    m.rearT -= dt;
    const s = 1 - Math.max(0, m.rearT) / REAR_TIME;
    const r = Math.min(1, Math.sin(Math.PI * s) * 1.5);
    m.rearR = r;
    pitch += 0.85 * r;
    for (let i = 0; i < 2; i++) {
      hip[i] += (0.9 + Math.sin(state.time * 14 + i * 1.5) * 0.35 - hip[i]) * r;
      knee[i] += (-1.5 - knee[i]) * r;
    }
    for (let i = 2; i < 4; i++) { hip[i] += (-pitch - hip[i]) * r; knee[i] += (0.15 - knee[i]) * r; }
    neckX += (-0.05 - neckX) * r;
    headX += Math.sin(state.time * 7) * 0.25 * r;
  }

  // lean into turns and look where it's going
  const yawRate = wrapAngle(m.yaw - m.prevYaw) / Math.max(dt, 1e-4);
  m.prevYaw = m.yaw;
  m.turn += (yawRate - m.turn) * Math.min(1, dt * 6);
  const lean = clamp(m.turn * hs * 0.02, -0.25, 0.25);
  neckY += clamp(m.turn * 0.12, -0.45, 0.45);

  if (md.wings) bob += animateWings(m, dt, flying, jumping);

  // apply
  md.body.position.y = HIP_Y + bob + Math.sin(state.time * 2 + m.breath) * 0.006;
  md.body.rotation.x = pitch;
  md.body.rotation.z = lean;
  for (let i = 0; i < 4; i++) { md.legs[i].hip.rotation.x = hip[i]; md.legs[i].knee.rotation.x = knee[i]; }
  md.neck.rotation.x = neckX;
  md.neck.rotation.y = neckY;
  md.head.rotation.x = headX;

  // ears pin back at a gallop and flick now and then; eyes blink
  m.earT -= dt;
  if (m.earT <= 0) { m.earT = 1.5 + Math.random() * 4; m.earFlick = 1; m.earSide = Math.random() < 0.5 ? 0 : 1; }
  m.earFlick = Math.max(0, m.earFlick - dt * 5);
  const earBack = 0.6 * gw.gallop * move;
  md.ears.forEach((e, i) => {
    e.rotation.x = earBack + (i === m.earSide ? Math.sin(m.earFlick * Math.PI) * 0.6 : 0);
    e.rotation.z = (i ? -1 : 1) * 0.12;
  });
  m.blinkT -= dt;
  if (m.blinkT <= 0) m.blinkT = 2 + Math.random() * 4;
  for (const e of md.eyes) e.scale.y = m.blinkT < 0.12 ? 0.15 : 1;

  // tail: lazy swishes at rest, streams out behind at speed
  const fast = Math.max(gw.gallop * move, flying ? 1 : 0, m.airW * 0.6);
  m.swish = Math.max(0, m.swish - dt * 1.5);
  if (Math.random() < dt * 0.25) m.swish = 1;
  md.tail.rotation.x = -0.45 - 0.75 * fast - pitch * 0.5;
  md.tail.rotation.z = Math.sin(state.time * 7) * 0.35 * m.swish * (1 - fast);
  md.tailSegs.forEach((s, i) => {
    s.rotation.x = (i ? 0.06 * (1 - fast) : 0) + Math.sin(state.time * 10 - i * 0.8) * 0.08 * fast;
    s.rotation.z = Math.sin(state.time * (1.5 + fast * 6) - i * 0.9) * (0.04 + 0.1 * fast + 0.12 * m.swish);
  });

  md.root.position.copy(m.pos);
  md.root.rotation.y = m.yaw;
  md.root.updateMatrixWorld(true);
  md.seat.getWorldPosition(m.seatWorld);
}

// ---------------------------------------------------------------- horse spawning + AI
// face: white 'blaze' or 'star'; socks: legs (FL, FR, HL, HR) with white socks; points: black
// lower legs and ear tips; dorsal: a stripe down the back; dapples: light spots; pad: saddle cloth
export const HORSE_COATS = [
  { coat: 'Chestnut', body: 0x9a5527, mane: 0x4a2410, face: 'blaze', socks: [2, 3], pad: 0x2f5fa8 },
  { coat: 'Bay', body: 0x6e3f1d, mane: 0x1c1410, points: true, face: 'star', pad: 0xb03030 },
  { coat: 'Black', body: 0x2a2626, mane: 0x111111, face: 'star', socks: [0], pad: 0xd8b03a },
  { coat: 'White', body: 0xe9e4da, mane: 0xc9c0b0, pad: 0x2e7d4f },
  { coat: 'Gray', body: 0x8d8d8d, mane: 0x4b4b4b, dapples: true, pad: 0x7a3fa0 },
  { coat: 'Palomino', body: 0xd9a95e, mane: 0xf4ead0, face: 'blaze', socks: [1, 2], pad: 0x1f6f78 },
  { coat: 'Buckskin', body: 0xc8a064, mane: 0x2a1d12, points: true, dorsal: true, pad: 0xc4572a },
];
export const HORSE_NAMES = ['Biscuit', 'Thunder', 'Daisy', 'Pepper', 'Clover', 'Maple', 'Comet', 'Hazel', 'Shadow', 'Willow', 'Pumpkin', 'Rusty', 'Nugget', 'Oreo'];
export const UNICORN_NAMES = ['Sparkle', 'Stardust', 'Moonbeam', 'Twinkle'];
export const UNICORN_COAT = { coat: 'Unicorn', body: 0xfdf8ff, mane: 0xffffff, pad: 0xcdb4ff };

// A normal unicorn stands 2.3 blocks to the tip of its horn; a great unicorn is about a block taller.
export const GREAT_UNICORN_SIZE = 1.44;

export const mobs = [];
// size scales the whole animal: model, collision box, saddle height and stride (1 = normal size).
// Speeds scale with √size, so a bigger animal covers more ground at the same gait.
export function makeMob(kind, coat, name, p, size = 1) {
  const unicorn = kind === 'unicorn';
  const m = new Entity(0.45 * size, 1.5 * size);
  const pace = Math.sqrt(size);
  Object.assign(m, {
    kind, name, coat: coat.coat, size, pace,
    speed: (unicorn ? 12 : 8.5) * pace,
    walkSpeed: (unicorn ? 1.8 : 1.4) * pace,
    runSpeed: (unicorn ? 7.5 : 6.5) * pace,
    model: makeHorseModel(coat, unicorn),
    state: 'idle', aiTimer: rand() * 3, phase: 0, turnCd: 0, rider: null,
    // animation state
    gw: { walk: 1, trot: 0, gallop: 0 }, airTime: 0, airW: 0, landT: 0, rearT: 0, rearR: 0,
    idle: null, idleCd: 2 + Math.random() * 4, grazeW: 0, turn: 0, prevYaw: 0,
    earT: Math.random() * 3, earFlick: 0, earSide: 0, blinkT: Math.random() * 4, swish: 0,
    breath: Math.random() * 6, seatWorld: new THREE.Vector3(),
    baseH: 1.5 * size, riddenH: SEAT_REST_Y * size + 0.92, seatRestY: SEAT_REST_Y * size, // riddenH: room for the rider's head
    wingFold: 1, wingAmp: 0, wingFreq: 1, wingDihedral: 0.1, wingP: 0,
    label: unicorn ? `${name} the ${size > 1 ? 'Great ' : ''}Unicorn` : `${name} the ${coat.coat} horse`,
  });
  m.pos.copy(p);
  m.yaw = m.wanderYaw = m.prevYaw = rand() * Math.PI * 2;
  m.model.root.scale.setScalar(size);
  m.tag = nameTag(unicorn ? '✨ ' + name + ' ✨' : name);
  m.tag.position.set(0, 2.45, 0);
  m.tag.scale.divideScalar(size); // the tag sits above the scaled model, but its text stays the usual size
  m.model.root.add(m.tag);
  mobs.push(m);
  return m;
}

const tmp = new THREE.Vector3();
const SPARKLE_COLORS = [...RAINBOW_HEX, 0xffffff, 0xffffff];
export function updateMob(m, dt) {
  if (!m.rider) {
    m.aiTimer -= dt;
    m.turnCd -= dt;
    if (m.aiTimer <= 0) {
      const r = rand();
      if (r < 0.35) { m.state = 'idle'; m.aiTimer = 2 + rand() * 3; }
      else if (r < 0.55) { m.state = 'graze'; m.aiTimer = 3 + rand() * 4; }
      else if (r < 0.65) { m.state = 'run'; m.aiTimer = 2 + rand() * 2; m.wanderYaw = rand() * Math.PI * 2; m.runTo = rand() < 0.5 ? 4.2 * m.pace : m.runSpeed; }
      else { m.state = 'walk'; m.aiTimer = 2 + rand() * 4; m.wanderYaw = rand() * Math.PI * 2; }
    }
    let tx = 0, tz = 0;
    if (m.rearT > 0) m.state = 'idle';
    if (m.state === 'walk' || m.state === 'run') {
      const sp = m.state === 'run' ? m.runTo : m.walkSpeed; // runTo: trot or gallop
      const dx = -Math.sin(m.wanderYaw), dz = -Math.cos(m.wanderYaw), look = 2.5 + sp * 0.4;
      // turn around before walking into the sea or off the island
      if (m.turnCd <= 0 && columnTop(Math.floor(m.pos.x + dx * look), Math.floor(m.pos.z + dz * look)) <= WATER) {
        m.wanderYaw += Math.PI + (rand() - 0.5);
        m.turnCd = 1;
      }
      tx = dx * sp; tz = dz * sp;
      m.yaw = lerpAngle(m.yaw, m.wanderYaw, dt * 4);
      if (m.hitWall && m.onGround) m.vel.y = 9;
    }
    accelerate(m, tx, tz, dt, 3);
    if (m.inWater) m.vel.y = Math.max(m.vel.y, 2, m.hitWall ? ledgeJump(m, -Math.sin(m.yaw), -Math.cos(m.yaw)) : 0);
    m.glide = false;
    physics(m, dt);
  }

  animateHorse(m, dt);
  const md = m.model;
  const hs = Math.hypot(m.vel.x, m.vel.z);
  const tagDist = m.pos.distanceTo(player.pos);
  m.tag.visible = !m.rider && tagDist > 3 && tagDist < 14;

  // unicorn sparkles: a rainbow trail when moving, a twinkle from the horn when idle
  if (m.kind === 'unicorn') {
    const moving = hs > 1.5 || !m.onGround;
    if (moving) {
      const s = m.size; // the trail comes off the rump, wherever that is on this size of unicorn
      tmp.set(m.pos.x + Math.sin(m.yaw) * 0.9 * s + rnd(-0.3, 0.3) * s, m.pos.y + rnd(0.5, 1.3) * s, m.pos.z + Math.cos(m.yaw) * 0.9 * s + rnd(-0.3, 0.3) * s);
      spawnParticle(tmp, rnd(-0.3, 0.3), rnd(0, 0.6), rnd(-0.3, 0.3), SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)], rnd(0.6, 1), -0.5, rnd(0.6, 1.1));
    } else if (Math.random() < dt * 4 && md.horn) {
      md.horn.getWorldPosition(tmp);
      spawnParticle(tmp, rnd(-0.4, 0.4), rnd(0.3, 0.8), rnd(-0.4, 0.4), SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)], rnd(0.6, 1), -0.3, rnd(0.7, 1.1));
    }
  }
}
