import { HOTBAR, BLOCK_NAMES, ICON_TILE, TS, atlas } from './blocks.js';
import { player } from './player.js';
import { nearestMob, ridden } from './riding.js';
import { totalUnicorns, totalHorses, totalDragons } from './spawn.js';
import { DRAGON_HEARTS } from './dragon.js';
import { clockText } from './daynight.js';
import { playerCount } from './multiplayer.js';
import { session } from './net.js';

// The hotbar, the clock, the frame rate, and the status and score text.
export let selected = 0; // hotbar slot
const hotbarEl = document.getElementById('hotbar');
const slotEls = HOTBAR.map((t, i) => {
  const s = document.createElement('div');
  s.className = 'slot';
  s.title = BLOCK_NAMES[t];
  const c = document.createElement('canvas');
  c.width = c.height = TS;
  c.getContext('2d').drawImage(atlas, ICON_TILE[t] * TS, 0, TS, TS, 0, 0, TS, TS);
  const n = document.createElement('span');
  n.textContent = i + 1;
  s.append(c, n);
  hotbarEl.append(s);
  return s;
});
export function selectSlot(i) {
  selected = i;
  slotEls.forEach((s, j) => s.classList.toggle('sel', j === i));
}
selectSlot(0);

const clockEl = document.getElementById('clock'), crosshairEl = document.getElementById('crosshair');
const statusEl = document.getElementById('status'), scoreEl = document.getElementById('score'), promptEl = document.getElementById('prompt');
function setText(el, txt) { if (el._t !== txt) { el._t = txt; el.textContent = txt; } }

// frame rate, counted in real time (the game's dt is capped) and refreshed twice a second;
// hidden until F3 is pressed
const fpsEl = document.getElementById('fps');
export function toggleFps() { fpsEl.hidden = !fpsEl.hidden; }
let fpsFrames = 0, fpsStart = performance.now();
function updateFps() {
  fpsFrames++;
  const now = performance.now();
  if (now - fpsStart < 500) return;
  setText(fpsEl, `${Math.round(fpsFrames * 1000 / (now - fpsStart))} FPS`);
  fpsFrames = 0; fpsStart = now;
}

// the health of the dragon we're riding, as a row of hearts that shakes when it loses one
const heartsEl = document.getElementById('hearts');
const heartEls = Array.from({ length: DRAGON_HEARTS }, () => {
  const h = document.createElement('span');
  h.textContent = '♥';
  return heartsEl.appendChild(h);
});
let shownHealth = -1, shownDragon = null;
function updateHearts(m) {
  const hp = m?.kind === 'dragon' ? m.health : -1;
  if (hp === shownHealth && m === shownDragon) return;
  if (hp >= 0 && hp < shownHealth && m === shownDragon) { heartsEl.classList.remove('hurt'); void heartsEl.offsetWidth; heartsEl.classList.add('hurt'); }
  shownHealth = hp; shownDragon = m;
  heartsEl.hidden = hp < 0;
  heartEls.forEach((h, i) => h.classList.toggle('empty', i >= hp));
}

export function updateHud() {
  updateFps();
  setText(clockEl, clockText());
  const m = player.riding;
  updateHearts(m);
  crosshairEl.classList.toggle('hot', !!(m?.kind === 'dragon' && m.aimInRange)); // the dragon's flames reach
  if (m) {
    setText(statusEl, m.kind === 'dragon'
      ? `Riding ${m.label}\nSpace: take off / fly up · Shift: dive\nLeft click (hold): breathe fire · B: barrel roll (${m.rollCd > 0 ? `ready in ${m.rollCd.toFixed(1)}s` : 'flying'})\nE: get off`
      : m.kind === 'unicorn'
      ? `Riding ${m.label}\nSpace: fly up · Shift: fly down\nB: barrel roll (flying) · E: get off`
      : `Riding ${m.label}\nSpace: jump · E: get off`);
    setText(promptEl, '');
  } else {
    setText(statusEl, `On foot · Block: ${BLOCK_NAMES[HOTBAR[selected]]}`);
    const n = nearestMob();
    setText(promptEl, n ? `Press E to ride ${n.label}` : '');
  }
  let u = 0, h = 0, g = 0;
  for (const r of ridden) r.kind === 'unicorn' ? u++ : r.kind === 'dragon' ? g++ : h++;
  setText(scoreEl, (session.online ? `Players online: ${playerCount()}\n` : '') + `Unicorns ridden: ${u}/${totalUnicorns}\nHorses ridden: ${h}/${totalHorses}\nDragons ridden: ${g}/${totalDragons}` +
    (totalUnicorns && u === totalUnicorns ? '\n✨ You rode every unicorn! ✨' : '') +
    (totalDragons && g === totalDragons ? '\n🐉 You rode every dragon! 🐉' : ''));
}
