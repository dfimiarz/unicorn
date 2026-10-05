import { renderer } from './render.js';
import { state } from './state.js';

// Keyboard state, pointer lock and mouse look. What the keys do is in controls.js.
export const keys = {};
const overlay = document.getElementById('overlay');
export const isLocked = () => document.pointerLockElement === renderer.domElement;
overlay.addEventListener('click', () => renderer.domElement.requestPointerLock());
document.addEventListener('pointerlockchange', () => {
  overlay.style.display = isLocked() ? 'none' : 'flex';
  document.getElementById('go').textContent = 'Click to continue';
  if (!isLocked()) for (const k in keys) keys[k] = false;
});
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (isLocked() && e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('mousemove', e => {
  if (!isLocked()) return;
  state.yaw -= e.movementX * 0.0025;
  state.pitch = Math.max(-1.55, Math.min(1.55, state.pitch - e.movementY * 0.0025));
});
addEventListener('contextmenu', e => e.preventDefault());
