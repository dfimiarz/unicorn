import * as THREE from 'three';
import { lerpAngle } from './util.js';
import { session, send, on } from './net.js';
import { scene } from './render.js';
import { setBlock } from './world.js';
import { light } from './fire.js';
import { nameTag } from './modelkit.js';
import { player, makePlayerModel, posePlayer } from './player.js';
import { mobs } from './horse.js';
import { dragons } from './dragon.js';
import './spawn.js';
import { mount, mountAnswered } from './riding.js';
import { setClock } from './daynight.js';
import { keys, isLocked } from './input.js';
import { state } from './state.js';

// Playing together (the connection itself is in net.js, the server in server.js).
//
// Everyone builds the same world from the same seed, then catches up on the blocks changed since
// it began. Each computer sends where its player is a dozen times a second, and the others draw them
// there, in their own shirt colour with their name above.
//
// Every animal is run (its wandering about, its physics) by exactly one computer: its rider's, or
// the host's if nobody is riding it. That computer sends where it is and what it's doing; everywhere
// else the animal glides to match and only animates itself. What happens in the game is up to the
// server, by the rules in rules.js: which blocks catch fire, spread it and burn away (fire.js), and
// which dragons lose or heal hearts, which it tells everyone here.

const SEND_RATE = 12; // updates a second
const SHIRTS = [0xd94848, 0xe8a23a, 0x58b84a, 0x4a7ad9, 0x9b59d0, 0xe063a8, 0x3fb5b0, 0x8a6a4a];
const r3 = v => Math.round(v * 1000) / 1000;
const tmp = new THREE.Vector3(), prev = new THREE.Vector3();

// Animals are spawned in the same order on every computer, so their place in the list is an id
// everyone agrees on.
const animals = new Map();
mobs.forEach((m, i) => animals.set(m.netId = 'm' + i, m));
dragons.forEach((d, i) => animals.set(d.netId = 'd' + i, d));
const runsHere = a => a.rider === player || (!a.rider && session.isHost);
for (const a of animals.values()) a.remote = !runsHere(a);

// ---------------------------------------------------------------- other players
const others = new Map(); // id -> { id, name, model, pos, target, vel, yaw, pitch, riding }
function addPlayer(id, name) {
  let p = others.get(id);
  if (p) return p;
  const model = makePlayerModel(SHIRTS[id % SHIRTS.length]);
  const tag = nameTag(name);
  tag.position.set(0, 2.15, 0);
  model.root.add(tag);
  p = { id, name, model, pos: new THREE.Vector3(), target: null, vel: new THREE.Vector3(), yaw: 0, pitch: 0, riding: null };
  others.set(id, p);
  showStatus();
  return p;
}
function removePlayer(id) {
  const p = others.get(id);
  if (!p) return;
  if (p.riding) clearRider(p.riding);
  scene.remove(p.model.root);
  others.delete(id);
  showStatus();
}

// another player climbing on or off an animal (climbing on ourselves is mount() in riding.js)
function setRider(a, p) {
  a.rider = p; p.riding = a;
  a.h = a.riddenH; a.idle = null;
}
function clearRider(a) {
  if (a.rider && a.rider !== player) a.rider.riding = null;
  a.rider = null; a.h = a.baseH;
  if (a.kind === 'dragon') a.aiTimer = 1 + Math.random() * 2; // a dragon left in the air soon comes down
}
// The server's answer to who is riding an animal: us (it was free, so we get on), someone else,
// or nobody.
function riderIs(id, rider) {
  mountAnswered(id);
  const a = animals.get(id);
  if (!a) return;
  if (rider === session.id) { if (!player.riding && !a.rider) mount(a); return; }
  if (a.rider === player) return; // we're on it, or have only just got off and this is old news
  if (rider) setRider(a, others.get(rider) || addPlayer(rider, `Player ${rider}`));
  else if (a.rider) clearRider(a);
}

// ---------------------------------------------------------------- animals run elsewhere
function encode(a) {
  const e = { i: a.netId, p: [r3(a.pos.x), r3(a.pos.y), r3(a.pos.z)], v: [r3(a.vel.x), r3(a.vel.y), r3(a.vel.z)], y: r3(a.yaw), s: a.state };
  if (a.onGround) e.g = 1;
  if (a.inWater) e.w = 1;
  if (a.roll) e.r = [r3(a.roll.t), a.roll.dir];
  if (a.kind === 'dragon') {
    e.f = r3(a.fvy); e.k = a.breath[0]; if (a.rider) e.a = [r3(a.aimYaw), r3(a.aimPitch)];
    if (a.breathing) e.b = 1;
    if (a.breathOn) e.ff = [r3(a.fireFrom.x), r3(a.fireFrom.y), r3(a.fireFrom.z)]; // where its breath comes from, for the server
    e.c = [r3(a.rollCd), r3(a.dizzy)]; // so whoever runs it next shows the same roll cooldown
  }
  else if (a.glide) e.gl = 1;
  return e;
}
// Glide toward where the update says the animal is by now (it moves on at the speed it had), and
// take on what it's doing, for the animation.
function follow(a, dt, now) {
  const n = a.net;
  if (!n) return;
  const age = Math.min(0.25, now - n.at);
  tmp.set(n.p[0] + n.v[0] * age, n.p[1] + n.v[1] * age, n.p[2] + n.v[2] * age);
  if (a.pos.distanceToSquared(tmp) > 16) a.pos.copy(tmp);
  else a.pos.lerp(tmp, Math.min(1, dt * 12));
  a.vel.set(n.v[0], n.v[1], n.v[2]);
  a.yaw = lerpAngle(a.yaw, n.y, dt * 12);
  a.onGround = !!n.g; a.inWater = !!n.w;
  if (a.state !== n.s) {
    if (a.kind === 'dragon' && (a.state === 'fly' || a.state === 'land') && (n.s === 'idle' || n.s === 'walk')) a.landT = 1;
    a.state = n.s; a.stateT = 0;
  }
  if (n.r && !a.roll) a.roll = { t: n.r[0], dir: n.r[1] };
  if (a.kind === 'dragon') {
    a.fvy = n.f; a.breathing = !!n.b; if (n.a) [a.aimYaw, a.aimPitch] = n.a;
    if (n.c) [a.rollCd, a.dizzy] = n.c;
    a.rollCounted = !!a.roll; // a roll under way was already counted where it started
  }
  else a.glide = !!n.gl;
}

// ---------------------------------------------------------------- messages
on('join', m => addPlayer(m.id, m.name));
on('leave', m => removePlayer(m.id));
on('p', ({ id, s }) => {
  const p = others.get(id) || addPlayer(id, `Player ${id}`);
  p.target = s.p; p.yaw = s.y; p.pitch = s.pi;
});
on('a', ({ list }) => {
  const now = performance.now() / 1000;
  for (const e of list) {
    const a = animals.get(e.i);
    if (a && !runsHere(a)) { e.at = now; a.net = e; }
  }
});
on('rider', m => riderIs(m.id, m.rider));
// a dragon hurt or healed, as the server decides (out of hearts, its rider is thrown off: see controls.js)
function setHealth(id, hp) { const a = animals.get(id); if (a?.kind === 'dragon') a.health = hp; }
on('hp', m => setHealth(m.id, m.hp));
on('edit', m => setBlock(m.x, m.y, m.z, m.b));
on('time', m => setClock(m.hour));
on('host', showStatus);
on('disconnected', () => {
  // the server has gone: carry on alone
  for (const id of [...others.keys()]) removePlayer(id);
  showStatus();
});

// catching up on joining
if (session.online) {
  for (const [k, b] of session.edits) { const [x, y, z] = k.split(',').map(Number); setBlock(x, y, z, b); }
  for (const p of session.players) {
    const o = addPlayer(p.id, p.name);
    if (p.s) { o.target = p.s.p; o.yaw = p.s.y; o.pitch = p.s.pi; }
  }
  for (const [id, rider] of session.riders) riderIs(id, rider);
  for (const [k, t] of session.burns) { const [x, y, z] = k.split(',').map(Number); light(x, y, z, t); }
  for (const [id, hp] of session.hp) setHealth(id, hp);
  setClock(session.hour);
}

// ---------------------------------------------------------------- each frame
// Before the animals update: those run elsewhere glide toward their latest update, and so do the
// other players.
export function followOthers(dt) {
  const now = performance.now() / 1000;
  for (const a of animals.values()) {
    const here = runsHere(a);
    if (!here && !a.remote) a.net = null; // just handed over: wait for a fresh update, not an old one
    a.remote = !here;
    if (!here) follow(a, dt, now);
  }
  for (const p of others.values()) {
    if (!p.target) continue;
    prev.copy(p.pos);
    tmp.fromArray(p.target);
    if (p.pos.distanceToSquared(tmp) > 25 || !p.placed) p.pos.copy(tmp);
    else p.pos.lerp(tmp, Math.min(1, dt * 12));
    p.vel.subVectors(p.pos, prev).divideScalar(Math.max(dt, 1e-4));
    p.placed = true;
  }
}

// After the animals update (so the saddles are in place): pose the other players.
export function poseOthers(dt) {
  for (const p of others.values()) {
    p.model.root.visible = !!p.target || !!p.riding;
    posePlayer(p.model, p.riding, p.pos, p.vel, p.yaw, p.pitch, dt);
  }
}

// Then tell everyone where our player is, and the animals run here.
let sendIn = 0, wasFast = false;
// T can't be let go of while the game isn't running or looking, so stop fast-forwarding then
function stopFast() { if (wasFast) { wasFast = false; send({ t: 'ffwd', on: false }); } }
addEventListener('blur', stopFast);
document.addEventListener('pointerlockchange', () => { if (!isLocked()) stopFast(); });
export function sendUpdates(dt) {
  if (!session.online) return;
  const fast = isLocked() && !!keys.KeyT;
  if (fast !== wasFast) { wasFast = fast; send({ t: 'ffwd', on: fast }); }
  sendIn -= dt;
  if (sendIn > 0) return;
  sendIn = Math.max(0, sendIn + 1 / SEND_RATE);
  send({ t: 'p', s: { p: [r3(player.pos.x), r3(player.pos.y), r3(player.pos.z)], y: r3(state.yaw), pi: r3(state.pitch) } });
  const list = [];
  for (const a of animals.values()) if (runsHere(a)) list.push(encode(a));
  if (list.length) send({ t: 'a', list });
}

// is anyone (us or another player) within r blocks of pos, across the ground?
export function nearAnyPlayer(pos, r) {
  if (Math.hypot(pos.x - player.pos.x, pos.z - player.pos.z) < r) return true;
  for (const p of others.values()) if (Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z) < r) return true;
  return false;
}
export function playerCount() { return session.online ? others.size + 1 : 1; }

// who you are and how others join, on the start screen
function showStatus() {
  const el = document.getElementById('net');
  if (!el) return;
  if (!session.online) {
    el.textContent = 'Single player. To play together, start the game with: node server.js';
    return;
  }
  const n = playerCount();
  el.textContent = `Playing together as ${session.name}${session.isHost ? ' (host)' : ''} · ${n} player${n === 1 ? '' : 's'} online`
    + (session.lan.length ? `\nFriends on the same Wi-Fi can join at ${session.lan[0]}` : '');
}
showStatus();

// a hidden tab stops running the game, so let the server give the host's job to someone else
const away = () => { if (document.hidden) stopFast(); send({ t: 'away', on: document.hidden }); };
document.addEventListener('visibilitychange', away);
if (document.hidden) away();
