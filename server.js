// Unicorn Craft multiplayer server. Run it with
//
//   node server.js            (or PORT=9000 node server.js)
//
// and open the address it prints. Other computers on the same network open the network address
// it prints. It serves the game's files (never cached, so a refresh always picks up changes) and
// relays messages between the players over a WebSocket at /ws. It needs nothing installed beyond
// Node itself.
//
// The server keeps what a newcomer needs to join: the world seed (picked by the first player),
// every block changed since, the blocks on fire, who is riding which animal, and the time of day. One player is the
// host: their computer runs the animals nobody is riding, and the fires (see js/multiplayer.js).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const ROOT = __dirname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.m4a': 'audio/mp4' };

// ---------------------------------------------------------------- files
const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end(); } // a malformed %-escape
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel));
  // only the game's own files: nothing outside this folder, no hidden files (.git), not this script
  const hidden = path.relative(ROOT, file).split(path.sep).some(part => part.startsWith('.'));
  if (!file.startsWith(ROOT + path.sep) || hidden || path.basename(file) === 'server.js') { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- WebSocket (just enough of RFC 6455)
function sendFrame(socket, text) {
  if (socket.destroyed) return;
  const body = Buffer.from(text);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n])
    : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  socket.write(Buffer.concat([head, body]));
}
// Reads frames out of the socket and hands each complete text message to onText. A message bigger
// than the game ever sends closes the connection, rather than filling up the server's memory.
const MAX_MESSAGE = 64 * 1024;
function readFrames(socket, onText, onClose) {
  let buf = Buffer.alloc(0), parts = [];
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      const mask = masked ? buf.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (len + parts.reduce((n, b) => n + b.length, 0) > MAX_MESSAGE) return socket.destroy();
      if (buf.length < at + len) return;
      const payload = Buffer.from(buf.subarray(at, at + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(at + len);
      if (op === 8) { socket.end(Buffer.from([0x88, 0])); return onClose(); }       // close
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; } // ping → pong
      if (op === 1 || op === 0) {                                                       // text, or a continuation of it
        parts.push(payload);
        if (fin) { const text = Buffer.concat(parts).toString(); parts = []; onText(text); }
      }
    }
  });
  socket.on('close', onClose);
  socket.on('error', () => socket.destroy());
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const name = (url.searchParams.get('name') || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 20);
  join(socket, name);
});

// ---------------------------------------------------------------- the game
let seed = null;        // the world seed, once the first player has picked one
let chooser = null;     // the player picking it; everyone else waits for it
const waiting = [];
const edits = new Map();   // "x,y,z" -> block type, every block changed since the world began
const riders = new Map();  // animal id -> id of the player riding it
const burns = new Map();   // "x,y,z" -> when that block caught fire, for blocks still burning
const BURN_MAX = 60000;    // ms; longer than any block takes to burn away, even on a slow computer
function pruneBurns() {
  const now = Date.now();
  for (const [k, at] of burns) if (now - at > BURN_MAX) burns.delete(k);
}
const players = new Map(); // id -> { id, name, socket, ready, s }
let hostId = 0, nextId = 1;

// the clock: one day lasts 10 minutes, or 40 times faster while anyone holds T
const DAY_SECONDS = 600;
let hour = 5.6, clockAt = Date.now();
const fastForward = new Set();
function tickClock() {
  const now = Date.now();
  hour = (hour + (now - clockAt) / 1000 * 24 / DAY_SECONDS * (fastForward.size ? 40 : 1)) % 24;
  clockAt = now;
}
const timeMsg = () => (tickClock(), { t: 'time', hour, ffwd: fastForward.size > 0 });

const send = (p, msg) => sendFrame(p.socket, JSON.stringify(msg));
function broadcast(msg, except) {
  const text = JSON.stringify(msg);
  for (const p of players.values()) if (p.ready && p !== except) sendFrame(p.socket, text);
}

function join(socket, name) {
  const id = nextId++;
  const p = { id, name: name || `Player ${id}`, socket, ready: false, away: false, s: null, track: {}, tokens: BURST, tokensAt: Date.now() };
  players.set(id, p);
  readFrames(socket, text => {
    if (!allowance(p)) return; // sending far more than the game does: drop it
    try { receive(p, JSON.parse(text)); } catch { /* ignore bad messages */ }
  }, () => leave(p));
  if (seed !== null) welcome(p);
  else if (!chooser) { chooser = p; welcome(p); } // the first player picks the world
  else waiting.push(p);
}

// The host should be someone whose game is actually running: a browser pauses a hidden tab.
function pickHost(except) {
  const ready = [...players.values()].filter(o => o.ready);
  const current = players.get(hostId);
  if (current?.ready && !current.away) return;
  const next = ready.find(o => !o.away) || current?.ready && current || ready[0];
  const id = next ? next.id : 0;
  if (id !== hostId) { hostId = id; if (next) broadcast({ t: 'host', id }, except); }
}

function welcome(p) {
  p.ready = true;
  pickHost(p); // takes over if there's no host, or the host's tab is hidden; p hears it in the welcome
  const { hour: h, ffwd } = timeMsg();
  pruneBurns();
  const now = Date.now();
  send(p, {
    t: 'welcome', id: p.id, name: p.name, seed, host: hostId, hour: h, ffwd, lan: lanAddresses(),
    edits: [...edits], riders: [...riders], burns: [...burns].map(([k, at]) => [k, (now - at) / 1000]),
    players: [...players.values()].filter(o => o.ready && o !== p).map(o => ({ id: o.id, name: o.name, s: o.s })),
  });
  broadcast({ t: 'join', id: p.id, name: p.name }, p);
  console.log(`${p.name} joined (${[...players.values()].filter(o => o.ready).length} playing)`);
}

function leave(p) {
  if (!players.has(p.id)) return;
  players.delete(p.id);
  const w = waiting.indexOf(p);
  if (w >= 0) waiting.splice(w, 1);
  if (!p.ready) return;
  for (const [animal, rider] of riders) if (rider === p.id) { riders.delete(animal); broadcast({ t: 'rider', id: animal, rider: null }); }
  if (fastForward.delete(p.id)) broadcast(timeMsg());
  broadcast({ t: 'leave', id: p.id });
  if (chooser === p) { chooser = waiting.shift() || null; if (chooser) welcome(chooser); }
  pickHost();
  console.log(`${p.name} left`);
}

// ---------------------------------------------------------------- checking what players send
// The game runs in each player's browser, where anyone can change it, so the server checks every
// message before passing it on: that it's well formed (so it can't break anyone else's game), that
// a player only sends updates for the animals theirs to run, and that nobody moves faster, reaches
// further, or changes more of the world than the game allows. What a player does to their own
// game only shows up for everyone else through these messages.
//
// These follow the game's own numbers: H and REACH in js/config.js, the block types in
// js/blocks.js, FIRE_RANGE and DRAGON_HEARTS in js/dragon.js.
const H = 64, REACH = 6, FIRE_RANGE = 7, DRAGON_HEARTS = 10;
const AIR = 0, LAST_PLACEABLE = 9;      // the hotbar's blocks; bedrock (10) can't be placed
const FAR = 1e5;                        // further from the middle than anyone will ever walk
const RUN = 30, CLIMB = 30, FALL = 50;  // blocks a second: faster than any animal runs, flies or falls
const SLACK = 3;                        // blocks of leeway for the jitter in when messages arrive
const ANIMAL_STATES = new Set(['idle', 'walk', 'run', 'graze', 'takeoff', 'fly', 'land']);
const RATE = 200, BURST = 400;          // messages a second; the game sends a few dozen

const num = (v, lo = -FAR, hi = FAR) => typeof v === 'number' && v >= lo && v <= hi; // NaN and Infinity fail
const int = (v, lo = -FAR, hi = FAR) => Number.isInteger(v) && v >= lo && v <= hi;
const nums = (v, n, lo, hi) => Array.isArray(v) && v.length === n && v.every(x => num(x, lo, hi));
const isBlock = m => int(m.x) && int(m.y, 0, H - 1) && int(m.z);
const animalId = id => typeof id === 'string' && /^[md]\d{1,3}$/.test(id);

function allowance(p) {
  const now = Date.now();
  p.tokens = Math.min(BURST, p.tokens + (now - p.tokensAt) / 1000 * RATE);
  p.tokensAt = now;
  if (p.tokens < 1) return false;
  p.tokens--;
  return true;
}

// Where something (a player or an animal) is allowed to have got to since the last update: any
// further than it could have run, climbed or fallen in the time, and it only gets that far.
function moveTo(track, [x, y, z]) {
  const now = Date.now();
  if (track.pos) {
    const [px, py, pz] = track.pos, dt = (now - track.at) / 1000;
    const dx = x - px, dz = z - pz, d = Math.hypot(dx, dz), maxD = RUN * dt + SLACK;
    if (d > maxD) { x = px + dx / d * maxD; z = pz + dz / d * maxD; }
    y = Math.min(py + CLIMB * dt + SLACK, Math.max(py - FALL * dt - SLACK, y));
  }
  track.pos = [x, y, z]; track.at = now;
  return track.pos;
}
const near = (p, [x, y, z], r) => !!p.track.pos && Math.hypot(p.track.pos[0] - x, p.track.pos[1] - y, p.track.pos[2] - z) <= r;
const ridingOf = p => { for (const [animal, rider] of riders) if (rider === p.id) return animal; return null; };

const animals = new Map(); // animal id -> { pos, at, hp }, as last sent by whoever runs it
// One animal from an update, rebuilt from only the parts that check out, or null if it isn't theirs
// to send or doesn't make sense.
function animalUpdate(p, e) {
  if (!e || !animalId(e.i)) return null;
  const rider = riders.get(e.i);
  if (rider ? rider !== p.id : p.id !== hostId) return null; // its rider runs it, or the host if nobody's on it
  if (!nums(e.p, 3) || !nums(e.v, 3, -100, 100) || !num(e.y) || !ANIMAL_STATES.has(e.s)) return null;
  const dragon = e.i[0] === 'd';
  if (dragon && (!num(e.f, -100, 100) || !int(e.hp, 0, DRAGON_HEARTS))) return null;
  if (!animals.has(e.i)) animals.set(e.i, {});
  const a = animals.get(e.i);
  const out = { i: e.i, p: moveTo(a, e.p), v: e.v, y: e.y, s: e.s };
  if (e.g) out.g = 1;
  if (e.w) out.w = 1;
  if (Array.isArray(e.r) && num(e.r[0], 0, 10) && (e.r[1] === 1 || e.r[1] === -1)) out.r = [e.r[0], e.r[1]];
  if (dragon) {
    out.f = e.f; out.hp = a.hp = e.hp;
    if (e.b) out.b = 1;
    if (nums(e.a, 2)) out.a = e.a;
    if (nums(e.c, 4, -1, 1000)) out.c = e.c;
  } else if (e.gl) out.gl = 1;
  return out;
}

function receive(p, m) {
  if (!p.ready || !m) return;
  switch (m.t) {
    case 'seed': // the first player has picked the world; let everyone else in
      if (p !== chooser || seed !== null || !num(m.seed, -(2 ** 53), 2 ** 53)) return;
      seed = m.seed; chooser = null;
      while (waiting.length) welcome(waiting.shift());
      return;
    case 'p': { // where a player is, and where they're looking
      const s = m.s;
      if (!s || !nums(s.p, 3, -FAR, FAR) || !num(s.y) || !num(s.pi, -2, 2)) return;
      p.s = { p: moveTo(p.track, s.p), y: s.y, pi: s.pi };
      return broadcast({ t: 'p', id: p.id, s: p.s }, p);
    }
    case 'a': { // where the animals they run are
      if (!Array.isArray(m.list)) return;
      const list = m.list.slice(0, 2000).map(e => animalUpdate(p, e)).filter(Boolean);
      return list.length && broadcast({ t: 'a', list }, p);
    }
    case 'edit': { // a block broken or placed, within reach; or the host's fire burning one away
      if (!isBlock(m) || m.y === 0 || !int(m.b, AIR, LAST_PLACEABLE)) return;
      const k = `${m.x},${m.y},${m.z}`;
      const burnt = m.b === AIR && p.id === hostId && burns.has(k);
      if (!burnt && !near(p, [m.x + 0.5, m.y + 0.5, m.z + 0.5], REACH + 8)) return; // + a dragon rider's height, and lag
      edits.set(k, m.b); burns.delete(k);
      return broadcast({ t: 'edit', x: m.x, y: m.y, z: m.z, b: m.b }, p);
    }
    case 'mount': { // free, close by, not out of hearts, and they aren't already on something
      if (!animalId(m.id)) return;
      const a = animals.get(m.id);
      const ok = !riders.has(m.id) && !ridingOf(p) && a?.hp !== 0 && (!a?.pos || near(p, a.pos, 8));
      if (ok) { riders.set(m.id, p.id); broadcast({ t: 'rider', id: m.id, rider: p.id }); }
      else send(p, { t: 'rider', id: m.id, rider: riders.get(m.id) ?? null }); // no (someone got there first?)
      return;
    }
    case 'dismount':
      if (riders.get(m.id) === p.id) { riders.delete(m.id); broadcast({ t: 'rider', id: m.id, rider: null }); }
      return;
    case 'ignite': { // their dragon's breath reaching a block; fire is the host's job
      const host = players.get(hostId);
      if (!host || host === p || !isBlock(m) || ridingOf(p)?.[0] !== 'd' || !near(p, [m.x + 0.5, m.y + 0.5, m.z + 0.5], FIRE_RANGE + 6)) return;
      return send(host, { t: 'ignite', x: m.x, y: m.y, z: m.z });
    }
    case 'burn': // a block catching fire, which only the host decides
      if (p.id !== hostId || !isBlock(m)) return;
      pruneBurns(); burns.set(`${m.x},${m.y},${m.z}`, Date.now());
      return broadcast({ t: 'burn', x: m.x, y: m.y, z: m.z }, p);
    case 'away': p.away = !!m.on; return pickHost(); // their tab is hidden (or back)
    case 'ffwd':
      tickClock();
      if (m.on) fastForward.add(p.id); else fastForward.delete(p.id);
      return broadcast(timeMsg());
  }
}
setInterval(() => broadcast(timeMsg()), 2000);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}/`);
  return out;
}

server.listen(PORT, () => {
  console.log(`Unicorn Craft is running.\n  On this computer:  http://localhost:${PORT}/`);
  for (const a of lanAddresses()) console.log(`  On the network:    ${a}`);
  console.log('Add ?name=YourName to the address to pick a name.');
});
