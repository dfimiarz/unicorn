import { CHUNK_BUDGET_MS, MOB_ACTIVE_DIST } from './config.js';
import { renderer, camera } from './render.js';
import { updateChunks } from './meshing.js';
import { updateClouds } from './environment.js';
import { updateParticles } from './particles.js';
import { updateBubbles } from './bubbles.js';
import { updateFire } from './fire.js';
import { player, updatePlayerModel } from './player.js';
import { mobs, updateMob } from './horse.js';
import { dragons, updateDragon } from './dragon.js';
import './spawn.js';
import { updatePlayer } from './controls.js';
import { followOthers, poseOthers, sendUpdates, nearAnyPlayer } from './multiplayer.js';
import { updateCamera } from './camera.js';
import { updateSky } from './daynight.js';
import { updateHud } from './hud.js';
import { composer, renderGodRays } from './postfx.js';
import { state } from './state.js';

// Entry point: builds the start area, then runs the game loop.

// build the land around the start before the first frame; the rest streams in while playing
updateChunks(400, player.pos);

// start out facing the unicorn
{
  const u = mobs[0];
  state.yaw = Math.atan2(-(u.pos.x - player.pos.x), -(u.pos.z - player.pos.z));
}

function update(dt) {
  state.time += dt;
  updatePlayer(dt);
  followOthers(dt);
  for (const m of mobs) {
    // animals far from every player wait (hidden) until someone comes back
    const active = nearAnyPlayer(m.pos, MOB_ACTIVE_DIST);
    m.model.root.visible = active;
    if (active) updateMob(m, dt);
  }
  for (const d of dragons) {
    const active = nearAnyPlayer(d.pos, MOB_ACTIVE_DIST);
    d.model.root.visible = active;
    if (active) updateDragon(d, dt);
  }
  updatePlayerModel(dt);
  poseOthers(dt);
  updateFire(dt);
  updateParticles(dt);
  updateBubbles(dt, camera);
  updateClouds(dt, player.pos);
  updateChunks(CHUNK_BUDGET_MS, player.pos);
  updateCamera();
  updateSky(dt);
  updateHud();
  sendUpdates(dt);
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  renderGodRays();
  renderer.shadowMap.needsUpdate = true;
  composer.render();
}
requestAnimationFrame(frame);
