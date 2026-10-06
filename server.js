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
// every block changed since, the blocks on fire, who is riding which animal, the dragons' hearts,
// and the time of day. It also decides what happens, by the game's own rules (js/rules.js), so
// nobody can change them from their browser: it builds the same world from the seed (js/terrain.js)
// to check every block change against, runs the fires, and decides when dragons are hurt or heal.
// One player is the host: their computer runs the animals nobody is riding (see js/multiplayer.js).
// It needs Node 22 or later, to load the game's own modules.
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

// ---------------------------------------------------------------- the game's own world and rules
// shared with the browser, and loaded before the server starts listening
let H, REACH, B, HOTBAR, terrain, noise, rules, fire;
const loaded = Promise.all(['config', 'blocktypes', 'terrain', 'noise', 'rules'].map(m => import(`./js/${m}.js`)))
  .then(([config, blocktypes, t, n, r]) => {
    ({ H, REACH } = config); ({ B, HOTBAR } = blocktypes); terrain = t; noise = n; rules = r;
    // fires: the server lights them, spreads them and burns blocks away, and tells everyone
    fire = new rules.Fire({
      getBlock,
      burnAway(x, y, z) { setBlock(x, y, z, B.AIR); broadcast({ t: 'edit', x, y, z, b: B.AIR }); },
      onLight: f => broadcast({ t: 'burn', x: f.x, y: f.y, z: f.z }),
    }, true);
  });

// ---------------------------------------------------------------- the game
let seed = null;        // the world seed, once the first player has picked one
let chooser = null;     // the player picking it; everyone else waits for it
const waiting = [];
const edits = new Map();   // "x,y,z" -> block type, every block changed since the world began
const riders = new Map();  // animal id -> id of the player riding it
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
  send(p, {
    t: 'welcome', id: p.id, name: p.name, seed, host: hostId, hour: h, ffwd, lan: lanAddresses(),
    edits: [...edits], riders: [...riders],
    burns: [...fire.burning.values()].map(f => [`${f.x},${f.y},${f.z}`, f.t]),
    hp: [...dragons.values()].filter(d => d.health < rules.DRAGON_HEARTS).map(d => [d.id, d.health]),
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

// ---------------------------------------------------------------- the world
// The same world as everyone's game, built from the seed (see js/terrain.js), so block changes can
// be checked against what's really there, and fires run. Only chunks something happens in are built.
const chunks = new Map(); // "cx,cz" -> its blocks
function chunkAt(x, z) {
  const k = (x >> 4) + ',' + (z >> 4);
  let c = chunks.get(k);
  if (!c) chunks.set(k, c = terrain.generateChunk(x >> 4, z >> 4));
  return c;
}
function getBlock(x, y, z) {
  return terrain.inBounds(y) ? chunkAt(x, z)[terrain.lidx(x & 15, y, z & 15)] : B.AIR;
}
function setBlock(x, y, z, b) {
  chunkAt(x, z)[terrain.lidx(x & 15, y, z & 15)] = b;
  edits.set(`${x},${y},${z}`, b);
}
// blocks are placed against another block's face
const touchesSolid = (x, y, z) => y === 0 || [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  .some(([dx, dy, dz]) => getBlock(x + dx, y + dy, z + dz) !== B.AIR);

// ---------------------------------------------------------------- checking what players send
// The game runs in each player's browser, where anyone can change it, so the server checks every
// message before passing it on: that it's well formed (so it can't break anyone else's game), that
// a player only sends updates for the animals theirs to run, and that nobody moves faster, reaches
// further, or changes more of the world than the game allows. What a player does to their own
// game only shows up for everyone else through these messages.
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

// ---------------------------------------------------------------- dragons
// The server keeps each dragon as the rules need it (js/rules.js): where it is, from the updates
// of whoever runs it; whether its rider is breathing, from where and which way; whether it's in a
// barrel roll, which the server times itself and only allows once its cooldown is over; and its
// hearts, which only the server changes.
const dragons = new Map(); // id -> dragon
function dragonOf(id, k) {
  let d = dragons.get(id);
  if (!d) {
    const breath = k === 'b' ? 'bubbles' : 'fire', size = rules.DRAGON_SIZE[breath]; // its sort is fixed once seen
    dragons.set(id, d = {
      id, breath, size, baseH: size.h, h: size.h, breathRange: rules.BREATH_RANGE[breath], pos: { x: 0, y: 0, z: 0 },
      breathOn: false, heardAt: 0, fireFrom: { x: 0, y: 0, z: 0 }, fireDir: { x: 0, y: 0, z: -1 },
      health: rules.DRAGON_HEARTS, hurtCd: 0, healT: 0, roll: null, rollCounted: false, rollCd: 0, dizzy: 0,
    });
  }
  return d;
}
const AIM_YAW = 1, AIM_UP = 0.7, AIM_DOWN = -1.1; // how far a dragon's neck turns (see aimDragon in js/dragon.js)
const BREATH_FROM = 5;                            // its breath comes from its mouth, at most this far from its feet
const ROLL_EARLY = 0.3;                           // seconds a roll may start before the cooldown ends, for lag
function dragonUpdate(d, e, out, ridden) {
  const now = Date.now();
  [d.pos.x, d.pos.y, d.pos.z] = out.p;
  d.h = ridden ? d.size.riddenH : d.size.h;
  d.heardAt = now;
  // breathing (only with a rider on), from near its head, where it's aiming
  d.breathOn = ridden && !!e.b && nums(e.ff, 3) && Math.hypot(e.ff[0] - d.pos.x, e.ff[1] - d.pos.y, e.ff[2] - d.pos.z) <= BREATH_FROM;
  if (d.breathOn) {
    [d.fireFrom.x, d.fireFrom.y, d.fireFrom.z] = e.ff;
    const [ay, ap] = nums(e.a, 2) ? e.a : [0, 0];
    rules.breathDir(e.y, Math.max(-AIM_YAW, Math.min(AIM_YAW, ay)), Math.max(AIM_DOWN, Math.min(AIM_UP, ap)), d.fireDir);
    out.b = 1;
  }
  // a barrel roll, if it's flying and the last one's cooldown is over; it lasts as long as the
  // server says, and ends early if its runner stops rolling (touching down mid-roll)
  const r = Array.isArray(e.r) && num(e.r[0], 0, 1) && (e.r[1] === 1 || e.r[1] === -1) ? e.r : null;
  if (r && !d.roll && e.s === 'fly' && d.rollCd <= ROLL_EARLY) d.roll = { until: now + (1 - r[0]) * rules.ROLL_TIME * 1000 };
  if (!r) d.roll = null;
  if (r && d.roll) out.r = [r[0], r[1]];
}

// Ten times a second: the fires burn and spread, and dragons in fire or bubbles lose hearts, or heal.
const TICK = 0.1; // seconds
function tick() {
  fire.update(TICK);
  const now = Date.now();
  for (const d of dragons.values()) {
    if (d.roll && now > d.roll.until) d.roll = null;
    if (now - d.heardAt > 500) d.breathOn = false; // nothing from its rider for a while
    rules.rollCooldown(d, TICK);
  }
  for (const d of dragons.values()) {
    const was = d.health;
    rules.hurtOrHeal(d, TICK, rules.inBreath(d, dragons.values(), fire));
    if (d.health === was) continue;
    broadcast({ t: 'hp', id: d.id, hp: d.health });
    // out of hearts: it throws its rider off (their game does the throwing, see js/controls.js)
    if (d.health === 0 && riders.has(d.id)) { riders.delete(d.id); broadcast({ t: 'rider', id: d.id, rider: null }); }
  }
}

const animals = new Map(); // animal id -> { pos, at }, as last sent by whoever runs it
// One animal from an update, rebuilt from only the parts that check out, or null if it isn't theirs
// to send or doesn't make sense.
function animalUpdate(p, e) {
  if (!e || !animalId(e.i)) return null;
  const rider = riders.get(e.i);
  if (rider ? rider !== p.id : p.id !== hostId) return null; // its rider runs it, or the host if nobody's on it
  if (!nums(e.p, 3) || !nums(e.v, 3, -100, 100) || !num(e.y) || !ANIMAL_STATES.has(e.s)) return null;
  const dragon = e.i[0] === 'd';
  if (dragon && (!num(e.f, -100, 100) || (e.k !== 'f' && e.k !== 'b'))) return null;
  if (!animals.has(e.i)) animals.set(e.i, {});
  const a = animals.get(e.i);
  const out = { i: e.i, p: moveTo(a, e.p), v: e.v, y: e.y, s: e.s };
  if (e.g) out.g = 1;
  if (e.w) out.w = 1;
  if (dragon) {
    const d = dragonOf(e.i, e.k);
    out.f = e.f; out.k = d.breath[0];
    if (nums(e.a, 2)) out.a = e.a;
    if (nums(e.c, 2, 0, 100)) out.c = e.c;
    dragonUpdate(d, e, out, !!rider);
  } else {
    if (Array.isArray(e.r) && num(e.r[0], 0, 1) && (e.r[1] === 1 || e.r[1] === -1)) out.r = [e.r[0], e.r[1]];
    if (e.gl) out.gl = 1;
  }
  return out;
}

function receive(p, m) {
  if (!p.ready || !m) return;
  switch (m.t) {
    case 'seed': // the first player has picked the world; let everyone else in
      if (p !== chooser || seed !== null || !int(m.seed, -(2 ** 31), 2 ** 31)) return;
      seed = m.seed; chooser = null;
      noise.setSeed(seed);
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
    case 'edit': { // a block broken or placed within reach, where there's a block to break or room to place one
      if (seed === null || !isBlock(m) || !(m.b === B.AIR || HOTBAR.includes(m.b))) return;
      // (reach first, so nobody can make the server build chunks far away)
      if (!near(p, [m.x + 0.5, m.y + 0.5, m.z + 0.5], REACH + 8)) return; // + a dragon rider's height, and lag
      const was = getBlock(m.x, m.y, m.z);
      const ok = m.b === B.AIR ? was !== B.AIR && was !== B.BEDROCK : was === B.AIR && touchesSolid(m.x, m.y, m.z);
      if (!ok) return send(p, { t: 'edit', x: m.x, y: m.y, z: m.z, b: was }); // put their copy back as it really is
      setBlock(m.x, m.y, m.z, m.b);
      return broadcast({ t: 'edit', x: m.x, y: m.y, z: m.z, b: m.b }, p);
    }
    case 'mount': { // free, close by, not out of hearts, and they aren't already on something
      if (!animalId(m.id)) return;
      const a = animals.get(m.id);
      const ok = !riders.has(m.id) && !ridingOf(p) && dragons.get(m.id)?.health !== 0 && (!a?.pos || near(p, a.pos, 8));
      if (ok) { riders.set(m.id, p.id); broadcast({ t: 'rider', id: m.id, rider: p.id }); }
      else send(p, { t: 'rider', id: m.id, rider: riders.get(m.id) ?? null }); // no (someone got there first?)
      return;
    }
    case 'dismount':
      if (riders.get(m.id) === p.id) { riders.delete(m.id); broadcast({ t: 'rider', id: m.id, rider: null }); }
      return;
    case 'ignite': { // their dragon's flames reaching a block, which catches if it burns
      const d = dragons.get(ridingOf(p));
      if (!d || d.breath !== 'fire' || !d.breathOn || !isBlock(m)) return;
      const { x, y, z } = d.fireFrom;
      if (Math.hypot(m.x + 0.5 - x, m.y + 0.5 - y, m.z + 0.5 - z) > d.breathRange + 1.5) return;
      fire.light(m.x, m.y, m.z);
      return;
    }
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

loaded.then(() => {
  setInterval(tick, TICK * 1000);
  server.listen(PORT, () => {
    console.log(`Unicorn Craft is running.\n  On this computer:  http://localhost:${PORT}/`);
    for (const a of lanAddresses()) console.log(`  On the network:    ${a}`);
    console.log('Add ?name=YourName to the address to pick a name.');
  });
});
