// The connection to the multiplayer server (server.js). This module connects before anything else
// is set up (world.js waits for it), because the world has to be built from the same seed as
// everyone else's. If the page didn't come from the game server (say, python3 -m http.server)
// there's nothing to connect to and the game runs on its own, as single player.
//
// What the messages mean, and what the game does with them, is in multiplayer.js.
export const session = {
  online: false, // connected to the server
  id: 0, name: '', host: 0,
  seed: null,    // the world everyone plays in; null until the first player has picked it
  hour: null, ffwd: false, lan: [], edits: [], burns: [], riders: [], players: [], // what the server sent on joining
  // the host's computer runs the animals nobody is riding, and the fires; single player is its own host
  get isHost() { return !this.online || this.host === this.id; },
};

let ws = null;
export function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// One handler per message type. Messages that arrive before their handler is registered wait for it.
const handlers = new Map(), backlog = new Map();
export function on(type, fn) {
  handlers.set(type, fn);
  const waiting = backlog.get(type);
  if (waiting) { backlog.delete(type); for (const m of waiting) fn(m); }
}
function dispatch(m) {
  const fn = handlers.get(m.t);
  if (fn) fn(m);
  else { if (!backlog.has(m.t)) backlog.set(m.t, []); backlog.get(m.t).push(m); }
}

await new Promise(resolve => {
  let settled = false;
  const settle = () => { if (!settled) { settled = true; resolve(); } };
  const name = new URLSearchParams(location.search).get('name') || '';
  try {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?name=${encodeURIComponent(name)}`);
  } catch { ws = null; return settle(); }
  // no answer at all: play alone rather than hang on a blank page
  const timer = setTimeout(() => { ws.close(); ws = null; settle(); }, 3000);
  ws.onopen = () => clearTimeout(timer);
  ws.onerror = () => { clearTimeout(timer); if (!settled) { ws = null; settle(); } };
  ws.onclose = () => {
    clearTimeout(timer);
    if (!settled) { ws = null; return settle(); }
    if (session.online) { session.online = false; dispatch({ t: 'disconnected' }); }
  };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') {
      const { t, ...rest } = m;
      Object.assign(session, rest, { online: true });
      return settle();
    }
    if (m.t === 'host') session.host = m.id;
    if (m.t === 'time') session.ffwd = m.ffwd;
    dispatch(m);
  };
});
