import * as THREE from 'three';
import { clamp, wrapAngle, rnd } from './util.js';
import { box, pivot, fixed, shade, bake, barrelRoll, LEATHER, GOLD } from './modelkit.js';
import { scene } from './render.js';
import { blowBubble } from './bubbles.js';
import { makeDragon } from './dragon.js';
import { state } from './state.js';

// Bubbles, the potato dragon: a round, pale purple potato of a body with a little face set into
// the front of it (two small horns, big round eyes and a wide heart-shaped snout), triangle spikes
// along the top, short stubby legs, a tail curled round its side, and small bat wings that buzz
// fast enough to fly. Its legs are too short to walk on, so it hops (see hop() in dragon.js), and it
// blows bubbles instead of breathing fire: they pop on other dragons and cost them hearts. It is
// ridden, flown and aimed like the other dragons (dragon.js); only its look and moves are here.
export const POTATO = {
  name: 'Bubbles', body: 0xcdb8ec, belly: 0xeee4fb, wing: 0xb59be2, bone: 0x8f73c2, spike: 0xa58ad6,
  horn: 0xf7eedf, eye: 0x2b2140, cheek: 0xf4b3cf,
};

const BODY_Y = 1.0;                  // the middle of the potato, above its feet
const RX = 0.86, RY = 0.78, RZ = 0.98; // its half width, height and length
const SEAT_Y = 0.88;                 // the saddle, above the middle

// A rounded lump of radii rx, ry, rz centred at (x, y, z), made of n stacked slices; each slice is
// a cross of two boxes, which cuts off its corners.
function blob(rx, ry, rz, color, x, y, z, parent, n = 4) {
  const g = fixed(x, y, z, parent), th = 2 * ry / n;
  for (let i = 0; i < n; i++) {
    const t = -1 + (2 * i + 1) / n, k = Math.sqrt(1 - t * t) * 0.92, w = 2 * rx * k, d = 2 * rz * k;
    box(w, th, d * 0.62, color, 0, t * ry, 0, g);
    box(w * 0.62, th, d, color, 0, t * ry, 0, g);
  }
  return g;
}
// A little square pyramid `h` tall with a base `w` across, standing on (x, y, z) and tilted `tilt`
// radians forward (+) or back about x, so it can stand out from a curved surface.
function spike(w, h, color, x, y, z, tilt, parent) {
  const g = fixed(x, y, z, parent);
  g.rotation.x = tilt;
  for (let i = 0; i < 2; i++) box(w * (1 - i / 2), h / 2, w * (1 - i / 2), color, 0, h * (i + 0.5) / 2, 0, g);
  return g;
}
// where the top of the body is, at z along its length (on the ellipse running along its back),
// and which way it faces there, as a tilt about x
function topAt(z) {
  const y = RY * Math.sqrt(Math.max(0, 1 - (z / RZ) ** 2));
  return [y, Math.atan2(-z / (RZ * RZ), y / (RY * RY))];
}

function makePotatoModel(c) {
  const root = new THREE.Group();
  const body = pivot(0, BODY_Y, 0, root);
  const darker = shade(c.body, 0.86);

  // the potato: a big lump with a smaller one on it, dotted with darker spots ("eyes", like a real
  // potato's), and a paler belly
  blob(RX, RY, RZ, c.body, 0, 0, 0, body, 6);
  blob(0.42, 0.38, 0.44, c.body, 0.42, 0.28, 0.46, body);
  blob(0.6, 0.48, 0.3, c.belly, 0, -0.26, -RZ * 0.72, body);
  for (const [u, v] of [[0.6, 1.1], [2.2, 1.3], [3.6, 1.2], [5.0, 1.5], [1.0, 1.8]]) {
    // spots over the back and sides (u round the body from the right side, v down from the top),
    // none on the face
    const sv = Math.sin(v);
    box(0.1, 0.08, 0.1, darker, RX * 0.99 * sv * Math.cos(u), RY * 0.99 * Math.cos(v), RZ * 0.99 * sv * Math.sin(u), body);
  }

  // triangle spikes along the top, in front of the saddle and behind it
  for (const z of [-0.84, -0.62, 0.5, 0.7, 0.88]) {
    const [y, tilt] = topAt(z), big = z < 0 ? 1 : 1 - (z - 0.5) * 0.8;
    spike(0.2 * big, 0.26 * big, c.spike, 0, y - 0.04, z, tilt, body);
  }

  // saddle: a blanket over the top, a seat with a pommel and cantle, and a strap
  const blanket = shade(c.wing, 0.7);
  box(0.9, 0.04, 0.78, blanket, 0, 0.78, 0, body);
  for (const s of [-1, 1]) {
    box(0.03, 0.24, 0.76, blanket, s * 0.46, 0.68, 0, body);
    box(0.034, 0.03, 0.78, GOLD, s * 0.462, 0.57, 0, body);
  }
  box(0.52, 0.1, 0.5, LEATHER, 0, 0.83, 0, body);
  box(0.22, 0.16, 0.08, LEATHER, 0, 0.93, -0.25, body);
  box(0.38, 0.13, 0.08, LEATHER, 0, 0.92, 0.25, body);
  const seat = pivot(0, SEAT_Y, 0, body);

  // the face, set into the front of the body
  const head = pivot(0, -0.05, -RZ * 0.72, body);
  blob(0.44, 0.38, 0.34, c.body, 0, 0.02, -0.12, head, 5);
  for (const s of [-1, 1]) {
    blob(0.17, 0.15, 0.15, c.belly, s * 0.1, -0.13, -0.36, head, 3); // the two halves of the heart-shaped snout
    box(0.07, 0.07, 0.03, c.eye, s * 0.11, -0.09, -0.52, head);       // nostril
    box(0.1, 0.05, 0.03, c.cheek, s * 0.3, -0.07, -0.36, head);       // a pink cheek
    // a small horn on each side of the top of the head, leaning out
    const horn = fixed(s * 0.22, 0.32, -0.12, head);
    horn.rotation.set(0.25, 0, -s * 0.4);
    box(0.12, 0.14, 0.12, c.horn, 0, 0.02, 0, horn);
    box(0.06, 0.12, 0.06, shade(c.horn, 0.9), 0, 0.14, 0, horn);
  }
  const jaw = pivot(0, -0.26, -0.3, head);
  box(0.4, 0.12, 0.26, c.body, 0, -0.02, -0.08, jaw);
  box(0.3, 0.03, 0.2, 0xb04a6a, 0, 0.035, -0.1, jaw); // the inside of the mouth, seen when it opens
  // big round eyes: a white ring round a dark middle with a glint in it, kept separate so they can blink
  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = box(0.21, 0.23, 0.05, 0xffffff, s * 0.19, 0.1, -0.42, head);
    eye.userData.bake = false;
    box(0.15, 0.17, 0.03, c.eye, s * 0.01, -0.01, -0.02, eye);
    box(0.05, 0.05, 0.02, 0xffffff, -s * 0.03, 0.04, -0.04, eye);
    eyes.push(eye);
  }

  // four short stubby legs with three claws on each foot
  const legs = [];
  for (const fz of [-1, 1]) for (const s of [-1, 1]) {
    const hip = pivot(s * 0.48, -0.56, fz * 0.42, body);
    box(0.3, 0.36, 0.32, c.body, 0, -0.12, 0, hip);
    box(0.34, 0.12, 0.42, darker, 0, -0.38, -0.04, hip);
    for (let k = -1; k <= 1; k++) box(0.06, 0.06, 0.08, c.horn, k * 0.11, -0.4, -0.28, hip);
    legs.push({ hip, front: fz < 0 });
  }

  // tail: from low behind, curling round the right side, with triangle spikes and a spade on the end
  const tail = pivot(0, -0.46, RZ * 0.82, body);
  const tailSegs = [];
  let parent = tail;
  for (let i = 0; i < 5; i++) {
    const seg = pivot(0, 0, i ? 0.34 : 0, parent), w = 0.3 - i * 0.04;
    box(w, w * 0.8, 0.38, c.body, 0, 0, 0.17, seg);
    if (i % 2 === 0) spike(w * 0.6, w * 0.6, c.spike, 0, w * 0.36, 0.17, 0, seg);
    tailSegs.push(seg);
    parent = seg;
  }
  const spade = fixed(0, 0, 0.42, parent);
  spade.rotation.y = Math.PI / 4;
  box(0.26, 0.04, 0.26, c.spike, 0, 0, 0, spade);

  const wings = [makeBatWing(-1, body, c), makeBatWing(1, body, c)];

  bake(root);
  scene.add(root);
  return { root, body, seat, head, jaw, eyes, legs, tail, tailSegs, wings };
}

// A small bat wing (s = -1 left, +1 right), spanning out along s*x with its skin lying flat behind:
// an arm bone out to the wrist, and three finger bones fanning back from there with the skin
// stretched between them, dipping in a scallop between each pair of fingertips. Shoulder rotation
// order ZXY = sweep (y) and twist (x) within the wing, then raise or flap (z) about the body, so
// at rest the twist can turn its skin to face forward, held up beside the body as in the drawing.
const ARM = 0.42, FINGERS = [[0.15, 0.62], [0.75, 0.56], [1.35, 0.46]]; // [radians back from straight out, length]
function makeBatWing(s, parent, c) {
  const shoulder = pivot(s * 0.7, 0.5, 0.04, parent);
  shoulder.rotation.order = 'ZXY';
  box(0.2, 0.14, 0.14, c.body, s * 0.04, 0, 0, shoulder);
  box(ARM, 0.07, 0.07, c.bone, s * ARM / 2, 0, 0, shoulder);
  // skin between the arm and the body
  for (let i = 0; i < 3; i++) {
    const x = 0.08 + i * 0.14, depth = 0.38 - 0.05 * Math.sin(Math.PI * (i + 0.5) / 3);
    box(0.15, 0.015, depth, c.wing, s * x, 0, depth / 2, shoulder);
  }
  const hand = pivot(s * ARM, 0, 0, shoulder);
  hand.rotation.order = 'YXZ';
  box(0.06, 0.12, 0.06, c.horn, s * 0.02, 0.07, -0.02, hand); // thumb claw
  for (const [dir, len] of FINGERS) {
    const f = fixed(0, 0, 0, hand);
    f.rotation.y = -s * dir;
    box(len, 0.045, 0.045, c.bone, s * len / 2, 0.01, 0, f);
  }
  // the skin: thin vanes fanning out from the wrist, long at each finger and shorter in between
  for (let i = 0; i <= 6; i++) {
    const dir = 0.15 + 1.4 * i / 6, j = dir < FINGERS[1][0] ? 0 : 1;
    const [a0, l0] = FINGERS[j], [a1, l1] = FINGERS[j + 1], t = clamp((dir - a0) / (a1 - a0), 0, 1);
    const len = (l0 + (l1 - l0) * t) * (1 - 0.22 * Math.sin(Math.PI * t));
    const v = fixed(0, 0, 0, hand);
    v.rotation.y = -s * dir;
    box(len, 0.015, 0.2, c.wing, s * len / 2, 0, 0, v);
  }
  return { shoulder, hand, s };
}

// How it moves: squashed flat as it lands from each hop and stretched tall on the way up; four
// little legs kicked out in the air and tucked up in flight; tiny wings held up beside it at rest
// (as in the drawing) and buzzing fast in flight; its face turned to wherever its rider aims.
function animatePotato(d, dt) {
  const md = d.model;
  const flying = d.state === 'fly' || d.state === 'land';
  d.flyW += ((flying ? 1 : 0) - d.flyW) * Math.min(1, dt * 3);
  const hopping = !d.onGround && !flying && d.state !== 'takeoff';
  d.hopW += ((hopping ? 1 : 0) - d.hopW) * Math.min(1, dt * 12);
  if (d.onGround && !d.wasGround && !flying) d.landT = Math.max(d.landT, 0.8); // plop
  d.wasGround = d.onGround;
  d.phase = (d.phase + dt * 1.5) % 1; // the rider's reins jiggle along with this (see player.js)

  let takeoffC = 0;
  if (d.state === 'takeoff') takeoffC = Math.min(1, d.stateT / 0.5);
  d.landT = Math.max(0, d.landT - dt * 4);

  // squash and stretch, keeping its volume about the same
  const stretch = hopping ? clamp(d.vel.y * 0.025, -0.08, 0.12) : 0;
  const sy = 1 - 0.24 * d.landT - 0.2 * takeoffC + stretch + Math.sin(state.time * 1.6 + d.breath) * 0.012;
  const sxz = 1 / Math.sqrt(sy);

  // in the air: nose up on the way up a hop and down on the way down; flying, pitch with the climb,
  // bank into turns and bob with the wingbeats
  const yawRate = wrapAngle(d.yaw - d.prevYaw) / Math.max(dt, 1e-4);
  d.prevYaw = d.yaw;
  d.turn += (yawRate - d.turn) * Math.min(1, dt * 4);
  let pitch = clamp(d.vel.y * 0.03, -0.18, 0.18) * d.hopW, roll = 0, bob = 0;
  if (d.flyW > 0.001) {
    pitch += clamp(d.fvy * 0.05, -0.25, 0.3) * d.flyW;
    roll += clamp(d.turn * 0.5, -0.45, 0.45) * d.flyW;
  }

  // wings: up beside the body at rest, a flutter on each hop, buzzing in flight
  let up = 1, amp = 0, freq = 6;
  if (flying) { up = 0; amp = 0.75; freq = 7; }
  else if (d.state === 'takeoff') { up = 1 - takeoffC; amp = 0.7 * takeoffC; freq = 7; }
  else if (hopping) { up = 0.6; amp = 0.35; freq = 8; }
  else if (d.idle === 'flutter') { up = 0.5; amp = 0.4; freq = 9; }
  const k = Math.min(1, dt * 8);
  d.wingFold += (up - d.wingFold) * k;
  d.wingAmp += (amp - d.wingAmp) * k;
  d.wingFreq += (freq - d.wingFreq) * k;
  d.wingP += dt * d.wingFreq * Math.PI * 2;
  const beat = Math.sin(d.wingP);
  for (const w of md.wings) {
    w.shoulder.rotation.set(1.2 * d.wingFold, -w.s * 0.12 * d.wingFold, w.s * (0.2 + 0.85 * d.wingFold + d.wingAmp * beat));
    w.hand.rotation.set(0, -w.s * 0.3 * d.wingFold, w.s * d.wingAmp * 0.4 * Math.sin(d.wingP - 0.8));
  }
  bob -= beat * 0.06 * d.wingAmp * d.flyW;

  // legs: kicked out front and back in a hop, dangling in flight
  for (const L of md.legs) {
    const dir = L.front ? 1 : -1;
    L.hip.rotation.x = dir * (0.5 * d.hopW + (0.35 + Math.sin(state.time * 3 + (L.front ? 0 : 1)) * 0.1) * d.flyW) - 0.25 * d.landT * dir;
  }

  // idle: look around, flutter its wings, or sniffle and blow a little bubble out of its nose
  d.idleCd -= dt;
  if (!d.idle && d.idleCd <= 0 && d.state === 'idle' && !d.rider) {
    const r = Math.random();
    d.idle = r < 0.45 ? 'look' : r < 0.7 ? 'flutter' : 'sniffle';
    d.idleT = 0; d.lookTo = rnd(-0.6, 0.6);
    d.idleCd = 3 + Math.random() * 5;
  }
  let headYaw = 0, headUp = 0, jawOpen = 0;
  if (d.idle) {
    d.idleT += dt;
    const len = d.idle === 'look' ? 2.4 : d.idle === 'flutter' ? 1.2 : 1.6;
    const s = d.idleT / len, env = Math.sin(Math.PI * Math.min(1, s));
    if (d.idle === 'look') headYaw = d.lookTo * env;
    else if (d.idle === 'sniffle') {
      headUp = 0.12 * env + Math.sin(d.idleT * 30) * 0.03 * env; // a twitchy little sniff
      if (s > 0.5 && !d.sniffled) {
        d.sniffled = true;
        blowBubble(md.head.localToWorld(bubbleAt.set(0.11, -0.09, -0.56)), bubbleVel.set(rnd(-0.3, 0.3), 0.4, rnd(-0.3, 0.3)), 0.14, d);
      }
    }
    if (s >= 1 || d.state !== 'idle') { d.idle = null; d.sniffled = false; }
  }
  // ridden, it looks where its rider aims, and opens wide to blow bubbles
  d.aimW += ((d.rider ? 1 : 0) - d.aimW) * Math.min(1, dt * 6);
  headYaw += d.aimYaw * d.aimW * 0.5;
  headUp += d.aimPitch * d.aimW * 0.5;
  d.fireW += ((d.breathing && d.rider ? 1 : 0) - d.fireW) * Math.min(1, dt * 8);
  jawOpen = Math.max(jawOpen, 0.5 * d.fireW);

  // apply
  md.body.scale.set(sxz, sy, sxz);
  md.body.position.set(0, BODY_Y * sy + bob, 0);
  md.body.rotation.set(pitch, 0, roll);
  barrelRoll(d, dt, md.body, 0); // about its middle
  md.head.rotation.set(headUp, headYaw, 0);
  md.jaw.rotation.x = -jawOpen;
  md.tail.rotation.x = -0.1 + 0.25 * d.hopW * (d.vel.y > 0 ? -1 : 1) * 0.5;
  md.tailSegs.forEach((s, i) => {
    s.rotation.y = 0.3 + 0.08 * i + Math.sin(state.time * 2.5 + d.breath - i * 0.6) * 0.07 - clamp(d.turn * 0.05, -0.1, 0.1);
    s.rotation.x = 0.04 * d.flyW;
  });

  d.blinkT -= dt;
  if (d.blinkT <= 0) d.blinkT = 2 + Math.random() * 4;
  for (const e of md.eyes) e.scale.y = d.blinkT < 0.14 ? 0.15 : 1;

  md.root.position.copy(d.pos);
  md.root.rotation.y = d.yaw;
  md.root.updateMatrixWorld(true);
  md.seat.getWorldPosition(d.seatWorld);
  md.head.localToWorld(d.fireFrom.set(0, -0.24, -0.56)); // its mouth, kept up to date for aiming too
  if (d.fireW > 0.6) blowBubbles(d, dt);
  else d.fireAcc = 0;
}

// A stream of bubbles from the open mouth, where its rider aims, carried along at its own speed too
const BUBBLE_RATE = 16, BUBBLE_RANGE = 8; // bubbles a second; about how far they float, in blocks
const bubbleAt = new THREE.Vector3(), bubbleVel = new THREE.Vector3();
function blowBubbles(d, dt) {
  const { fireFrom, fireDir } = d, a = d.yaw + d.aimYaw, cp = Math.cos(d.aimPitch);
  fireDir.set(-Math.sin(a) * cp, Math.sin(d.aimPitch), -Math.cos(a) * cp);
  for (d.fireAcc += dt * BUBBLE_RATE; d.fireAcc >= 1; d.fireAcc--) {
    const sp = rnd(8, 11);
    bubbleVel.set(fireDir.x * sp + rnd(-1, 1), fireDir.y * sp + rnd(-0.6, 1), fireDir.z * sp + rnd(-1, 1)).add(d.vel);
    blowBubble(fireFrom, bubbleVel, rnd(0.12, 0.3), d);
  }
}

export function makePotatoDragon(c, p) {
  const d = makeDragon(c, p, {
    makeModel: makePotatoModel, animate: animatePotato, hw: 0.85, h: 1.9, riddenH: 3.5, seatRestY: BODY_Y + SEAT_Y,
    tagY: 2.7, walkSpeed: 2.6, flySpeed: 10, hops: true, breathRange: BUBBLE_RANGE, weapon: 'blow bubbles', voice: 1.6,
  });
  Object.assign(d, { hopW: 0, wasGround: true, sniffled: false, straddle: 0.95 });
  return d;
}
