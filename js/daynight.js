import * as THREE from 'three';
import { WATER } from './config.js';
import { smoothstep } from './util.js';
import { renderer, scene, camera } from './render.js';
import { NIGHT_SKY, SUN_INTENSITY, MOON_INTENSITY, skyMat, skyScene, skyTarget, skyCubeCam, skyRadiance,
  sunTransmittance, MS_FILL, toneMapSky, sunDisc, moonDisc, stars, hemi, sunLight } from './sky.js';
import { water, waterMat, seaFloor, cloudMat } from './environment.js';
import { setGodRays } from './postfx.js';
import { lookDir } from './camera.js';
import { player } from './player.js';
import { keys, isLocked } from './input.js';
import { state } from './state.js';

// The day/night cycle: moves the sun and moon, and sets the lights, fog, water and god rays to match.
const UNDERWATER = new THREE.Color(0x1f4f8f);
const tmp = new THREE.Vector3();
const DAY_SECONDS = 600; // one full day takes 10 minutes (hold T to speed it up)
const SUN_TILT = 0.45;   // the sun's path leans south, peaking ~64° up at noon
const urlTime = new URLSearchParams(location.search).get('time');
let hour = urlTime !== null && !isNaN(+urlTime) ? +urlTime % 24 : 5.6; // start just before sunrise
const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), lightDir = new THREE.Vector3();
const skyAxis = new THREE.Vector3(0, -Math.sin(SUN_TILT), Math.cos(SUN_TILT));
const lastSkySun = new THREE.Vector3(9, 9, 9);
const sunColor = new THREE.Color(), fogColor = new THREE.Color(), zenColor = new THREE.Color(), warmColor = new THREE.Color();
const ZENITH = new THREE.Vector3(0, 1, 0), MOONLIGHT = new THREE.Color(0.55, 0.65, 1.0);
const trans = [0, 0, 0];
let sunUp = 1, dayAmt = 1;

// sky radiance in a direction, tone mapped like the sky shader, as a linear THREE.Color
function skyColorAt(dir, out) {
  const r = [0, 0, 0];
  skyRadiance(dir, sunDir, SUN_INTENSITY, r);
  skyRadiance(dir, moonDir, MOON_INTENSITY, r);
  const ms = smoothstep(-0.32, 0.0, sunDir.y);
  for (let c = 0; c < 3; c++) r[c] += MS_FILL[c] * ms;
  const t = toneMapSky(r), nf = 1 - 0.5 * Math.max(dir.y, 0);
  return out.setRGB(t[0] + NIGHT_SKY.x * nf, t[1] + NIGHT_SKY.y * nf, t[2] + NIGHT_SKY.z * nf, THREE.SRGBColorSpace);
}

export function updateSky(dt) {
  const speed = isLocked() && keys.KeyT ? 40 : 1;
  hour = (hour + dt * speed * 24 / DAY_SECONDS) % 24;
  const a = (hour - 6) / 24 * Math.PI * 2;
  sunDir.set(Math.cos(a), Math.sin(a) * Math.cos(SUN_TILT), Math.sin(a) * Math.sin(SUN_TILT)).normalize();
  moonDir.set(-sunDir.x, -sunDir.y, -sunDir.z + 0.2).normalize();
  const sunY = sunDir.y;

  // re-render the sky cube once the sun has moved a little
  if (lastSkySun.distanceTo(sunDir) > 0.002) {
    skyMat.uniforms.sunDir.value.copy(sunDir);
    skyMat.uniforms.moonDir.value.copy(moonDir);
    skyCubeCam.update(renderer, skyScene);
    lastSkySun.copy(sunDir);
  }

  // sunlight colour = what survives the trip through the air (white at noon, deep orange at sunset)
  sunTransmittance(sunDir, trans);
  const tMax = Math.max(trans[0], trans[1], trans[2], 1e-4);
  sunColor.setRGB(trans[0] / tMax, trans[1] / tMax, trans[2] / tMax);
  sunUp = smoothstep(-0.03, 0.1, sunY);
  dayAmt = smoothstep(-0.15, 0.3, sunY);
  const moonUp = smoothstep(-0.02, -0.15, sunY) * smoothstep(-0.05, 0.1, moonDir.y);

  // one shadow-casting light: the sun by day, the moon by night
  if (sunY > -0.04) {
    lightDir.copy(sunDir);
    sunLight.color.copy(sunColor);
    sunLight.intensity = 2.4 * sunUp * Math.sqrt(tMax);
  } else {
    lightDir.copy(moonDir);
    sunLight.color.copy(MOONLIGHT);
    sunLight.intensity = 0.6 * moonUp;
  }
  if (lightDir.y < 0.06) lightDir.y = 0.06; // keep grazing shadows from stretching to infinity
  lightDir.normalize();
  const cx = Math.round(player.pos.x), cz = Math.round(player.pos.z), cy = Math.round(player.pos.y);
  sunLight.target.position.set(cx, cy, cz);
  sunLight.position.set(cx, cy, cz).addScaledVector(lightDir, 160);

  // sky light: blue from above by day, warm from the horizon around sunrise/sunset, cool at night
  skyColorAt(ZENITH, zenColor);
  const zMax = Math.max(zenColor.r, zenColor.g, zenColor.b, 1e-4);
  zenColor.multiplyScalar(1 / zMax);
  hemi.color.setRGB(1, 1, 1).lerp(zenColor, 0.45);
  warmColor.copy(skyColorAt(tmp.set(sunDir.x, 0.05, sunDir.z).normalize(), warmColor));
  const wMax = Math.max(warmColor.r, warmColor.g, warmColor.b, 1e-4);
  const golden = smoothstep(0.45, 0.0, Math.abs(sunY)) * smoothstep(-0.2, -0.02, sunY);
  hemi.color.lerp(warmColor.multiplyScalar(1 / wMax), 0.35 * golden);
  hemi.color.lerp(MOONLIGHT, 1 - dayAmt);
  hemi.groundColor.setRGB(hemi.color.r * 0.62, hemi.color.g * 0.6, hemi.color.b * 0.48);
  hemi.intensity = 0.65 + 0.85 * dayAmt;

  // fog takes the colour of the horizon in the direction you're looking
  const look = lookDir();
  skyColorAt(tmp.set(look.x, 0.04, look.z).normalize(), fogColor);
  const under = camera.position.y < WATER + 0.9;
  if (under) {
    scene.background = UNDERWATER;
    scene.fog.color.copy(UNDERWATER).multiplyScalar(0.25 + 0.75 * dayAmt);
    scene.fog.near = 1; scene.fog.far = 22;
  } else {
    scene.background = skyTarget.texture;
    scene.fog.color.copy(fogColor);
    scene.fog.near = 45; scene.fog.far = 130;
  }
  cloudMat.emissive.copy(fogColor).multiplyScalar(0.35);
  cloudMat.color.setRGB(1, 1, 1).multiplyScalar(0.4 + 0.6 * dayAmt);

  // sun disc: dimmer and redder near the horizon
  const vis = smoothstep(-0.05, 0.01, sunY);
  sunDisc.position.copy(camera.position).addScaledVector(sunDir, 400);
  sunDisc.lookAt(camera.position);
  sunDisc.material.uniforms.color.value.copy(sunColor).multiplyScalar(vis * (0.3 + 0.7 * Math.sqrt(tMax)));
  sunDisc.visible = vis > 0;
  moonDisc.position.copy(camera.position).addScaledVector(moonDir, 400);
  moonDisc.lookAt(camera.position);
  moonDisc.material.uniforms.alpha.value = smoothstep(-0.05, 0.08, moonDir.y) * (1 - 0.8 * dayAmt);
  const starAlpha = smoothstep(-0.02, -0.25, sunY);
  stars.material.uniforms.alpha.value = starAlpha;
  stars.material.uniforms.time.value = state.time;
  stars.visible = starAlpha > 0.005;
  stars.position.copy(camera.position);
  stars.quaternion.setFromAxisAngle(skyAxis, a);

  // water reflects the sun (or the moon at night)
  water.position.x = seaFloor.position.x = camera.position.x;
  water.position.z = seaFloor.position.z = camera.position.z;
  const wu = waterMat.uniforms;
  wu.time.value = state.time;
  if (sunY > -0.04) { wu.sunDir.value.copy(sunDir); wu.sunColor.value.copy(sunColor).multiplyScalar(sunUp * Math.sqrt(tMax)); }
  else { wu.sunDir.value.copy(moonDir); wu.sunColor.value.copy(MOONLIGHT).multiplyScalar(0.35 * moonUp); }
  wu.ambient.value.copy(hemi.color).multiplyScalar(hemi.intensity * 0.6);

  // god rays: strongest when looking toward a low sun
  const facing = look.dot(sunDir);
  let rays = 0;
  if (!under && facing > 0.05 && sunY > -0.03) {
    tmp.copy(camera.position).addScaledVector(sunDir, 400).project(camera);
    rays = 0.55 * smoothstep(0.05, 0.6, facing) * sunUp * (0.5 + 0.8 * (1 - smoothstep(0.05, 0.6, sunY)));
  }
  setGodRays(rays, sunColor, tmp.x * 0.5 + 0.5, tmp.y * 0.5 + 0.5, camera.aspect); // sun position only used when rays > 0
}

const PHASES = [[4.8, 'Night'], [5.8, 'Dawn'], [7.2, 'Sunrise'], [11, 'Morning'], [14, 'Midday'], [17, 'Afternoon'], [18.6, 'Sunset'], [19.5, 'Dusk'], [24, 'Night']];
export function clockText() {
  const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
  const phase = PHASES.find(p => hour < p[0])[1];
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} · ${phase}` + (isLocked() && keys.KeyT ? ' ⏩' : '');
}
