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
// Reads frames out of the socket and hands each complete text message to onText.
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
  const name = (url.searchParams.get('name') || '').trim().slice(0, 20);
  join(socket, name);
});

// ---------------------------------------------------------------- the game
let seed = null;        // the world seed, once the first player has picked one
let chooser = null;     // the player picking it; everyone else waits for it
const waiting = [];
const edits = new Map();   // "x,y,z" -> block type, every block changed since the world began
const riders = new Map();  // animal id -> id of the player riding it
const burns = new Map();   // "x,y,z" -> when that block caught fire, for blocks still burning
const BURN_MAX = 15000;    // ms; longer than any block takes to burn away
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
  const p = { id, name: name || `Player ${id}`, socket, ready: false, away: false, s: null };
  players.set(id, p);
  readFrames(socket, text => { try { receive(p, JSON.parse(text)); } catch { /* ignore bad messages */ } }, () => leave(p));
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

function receive(p, m) {
  if (!p.ready) return;
  switch (m.t) {
    case 'seed': // the first player has picked the world; let everyone else in
      if (p !== chooser || seed !== null) return;
      seed = m.seed; chooser = null;
      while (waiting.length) welcome(waiting.shift());
      return;
    case 'p': p.s = m.s; return broadcast({ t: 'p', id: p.id, s: m.s }, p);  // where a player is
    case 'a': return broadcast(m, p);                                          // where the animals are
    case 'edit': edits.set(`${m.x},${m.y},${m.z}`, m.b); burns.delete(`${m.x},${m.y},${m.z}`); return broadcast(m, p);
    case 'mount': // free, and they aren't already on something
      if (!riders.has(m.id) && ![...riders.values()].includes(p.id)) { riders.set(m.id, p.id); broadcast({ t: 'rider', id: m.id, rider: p.id }); }
      else send(p, { t: 'rider', id: m.id, rider: riders.get(m.id) ?? null }); // someone got there first
      return;
    case 'dismount':
      if (riders.get(m.id) === p.id) { riders.delete(m.id); broadcast({ t: 'rider', id: m.id, rider: null }); }
      return;
    case 'ignite': { const host = players.get(hostId); if (host && host !== p) send(host, m); return; } // fire is the host's job
    case 'burn': pruneBurns(); burns.set(`${m.x},${m.y},${m.z}`, Date.now()); return broadcast(m, p);
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
