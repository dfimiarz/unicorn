import * as THREE from 'three';
import { renderer, scene } from './render.js';
import { clamp } from './util.js';

// Sky, sun, moon, stars and the lights. The day/night cycle that drives them is in daynight.js.
// Physically based sky: single-scattering Rayleigh + Mie through a spherical atmosphere,
// with the planet's shadow so twilight fades properly after sunset.
const ATMOS_GLSL = /* glsl */`
  #define PI 3.141592653589793
  const float R_PLANET = 6371e3;
  const float R_ATMOS = 6471e3;
  const vec3 K_RLH = vec3(5.5e-6, 13.0e-6, 22.4e-6);
  const vec3 K_OZONE = vec3(0.98e-6, 2.82e-6, 0.13e-6); // absorbs orange/green: keeps horizons and twilight blue
  const float K_MIE = 21e-6;
  const float SH_RLH = 8e3;
  const float SH_MIE = 1.2e3;
  const float G_MIE = 0.758;
  const vec3 EYE = vec3(0.0, 6372e3, 0.0);

  vec2 rsi(vec3 r0, vec3 rd, float sr) {
    float b = dot(rd, r0);
    float d = b * b - (dot(r0, r0) - sr * sr);
    if (d < 0.0) return vec2(1e9, -1e9);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
  }

  vec3 atmosphere(vec3 r, vec3 pSun, float iSun) {
    vec2 p = rsi(EYE, r, R_ATMOS);
    if (p.x > p.y) return vec3(0.0);
    float t0 = max(p.x, 0.0);
    float t1 = p.y;
    vec2 g = rsi(EYE, r, R_PLANET);
    if (g.x > 0.0) t1 = min(t1, g.x);
    float stepI = (t1 - t0) / float(ISTEPS);
    float mu = dot(r, pSun), mumu = mu * mu, gg = G_MIE * G_MIE;
    float pRlh = 3.0 / (16.0 * PI) * (1.0 + mumu);
    float pMie = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mumu + 1.0)) / (pow(1.0 + gg - 2.0 * mu * G_MIE, 1.5) * (2.0 + gg));
    vec3 totRlh = vec3(0.0), totMie = vec3(0.0);
    float odRlh = 0.0, odMie = 0.0;
    for (int i = 0; i < ISTEPS; i++) {
      vec3 pos = EYE + r * (t0 + stepI * (float(i) + 0.5));
      float h = length(pos) - R_PLANET;
      float dR = exp(-h / SH_RLH) * stepI, dM = exp(-h / SH_MIE) * stepI;
      odRlh += dR; odMie += dM;
      // skip points that are in the planet's shadow
      vec2 gs = rsi(pos, pSun, R_PLANET);
      if (gs.x > 0.0) continue;
      float stepJ = rsi(pos, pSun, R_ATMOS).y / float(JSTEPS);
      float jR = 0.0, jM = 0.0;
      for (int j = 0; j < JSTEPS; j++) {
        float hj = length(pos + pSun * stepJ * (float(j) + 0.5)) - R_PLANET;
        jR += exp(-hj / SH_RLH) * stepJ;
        jM += exp(-hj / SH_MIE) * stepJ;
      }
      vec3 attn = exp(-(K_MIE * 1.1 * (odMie + jM) + (K_RLH + K_OZONE) * (odRlh + jR)));
      totRlh += dR * attn; totMie += dM * attn;
    }
    return iSun * (pRlh * K_RLH * totRlh + pMie * K_MIE * totMie);
  }
`;
export const NIGHT_SKY = new THREE.Vector3(0.035, 0.055, 0.12);
export const SUN_INTENSITY = 22, MOON_INTENSITY = 0.5;

export const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { sunDir: { value: new THREE.Vector3(0, 1, 0) }, moonDir: { value: new THREE.Vector3(0, -1, 0) }, nightSky: { value: NIGHT_SKY } },
  vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    #define ISTEPS 14
    #define JSTEPS 6
    #define SKY_EXPOSURE 5.0
    const vec3 MS_FILL = vec3(0.02, 0.05, 0.12);
    uniform vec3 sunDir; uniform vec3 moonDir; uniform vec3 nightSky;
    varying vec3 vDir;
    ${ATMOS_GLSL}
    // exposure + tone curve: mostly luminance-based (keeps sunset hues saturated), a little per-channel
    // for soft highlights, then a gentle saturation lift
    vec3 toneMapSky(vec3 c) {
      float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
      vec3 a = 1.0 - exp(-SKY_EXPOSURE * c);
      vec3 b = min(vec3(1.0), c * (L > 0.0 ? (1.0 - exp(-SKY_EXPOSURE * L)) / L : 0.0));
      vec3 t = mix(a, b, 0.75);
      return clamp(mix(vec3(dot(t, vec3(0.2126, 0.7152, 0.0722))), t, 1.15), 0.0, 1.0);
    }
    void main() {
      vec3 dir = normalize(vDir);
      vec3 d = normalize(vec3(dir.x, max(dir.y, 0.03), dir.z)); // below ~2° the long path turns the haze pink; clamp it
      vec3 col = atmosphere(d, sunDir, ${SUN_INTENSITY.toFixed(1)}) + atmosphere(d, moonDir, ${MOON_INTENSITY.toFixed(2)});
      col += MS_FILL * smoothstep(-0.32, 0.0, sunDir.y);        // cheap stand-in for multiple scattering (blue hour)
      col = toneMapSky(col);
      col += nightSky * (1.0 - 0.5 * d.y);                     // faint airglow so night isn't pitch black
      gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);           // to linear; the output pass converts back to sRGB
    }`,
});
export const skyScene = new THREE.Scene();
skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(5, 32, 16), skyMat));
export const skyTarget = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: false });
export const skyCubeCam = new THREE.CubeCamera(0.1, 10, skyTarget);
scene.background = skyTarget.texture;

// JS twin of the scattering model (fewer steps) for fog, light colours and the sun's colour
const ATM = { rP: 6371e3, rA: 6471e3, kR: [5.5e-6, 13.0e-6, 22.4e-6], kO: [0.98e-6, 2.82e-6, 0.13e-6], kM: 21e-6, shR: 8e3, shM: 1.2e3, g: 0.758, eye: 6372e3 };
function rsiJS(ox, oy, oz, d, sr) {
  const b = d.x * ox + d.y * oy + d.z * oz, disc = b * b - (ox * ox + oy * oy + oz * oz - sr * sr);
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  return [-b - s, -b + s];
}
export function skyRadiance(dir, sun, iSun, out) {
  const p = rsiJS(0, ATM.eye, 0, dir, ATM.rA);
  if (!p) return out;
  const t0 = Math.max(p[0], 0);
  let t1 = p[1];
  const gp = rsiJS(0, ATM.eye, 0, dir, ATM.rP);
  if (gp && gp[0] > 0) t1 = Math.min(t1, gp[0]);
  const N = 8, M = 4, st = (t1 - t0) / N;
  const mu = dir.dot(sun), gg = ATM.g * ATM.g;
  const pR = 3 / (16 * Math.PI) * (1 + mu * mu);
  const pM = 3 / (8 * Math.PI) * ((1 - gg) * (mu * mu + 1)) / (Math.pow(1 + gg - 2 * mu * ATM.g, 1.5) * (2 + gg));
  let odR = 0, odM = 0;
  const totR = [0, 0, 0], totM = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = t0 + st * (i + 0.5);
    const px = dir.x * t, py = ATM.eye + dir.y * t, pz = dir.z * t;
    const h = Math.hypot(px, py, pz) - ATM.rP;
    const dR = Math.exp(-h / ATM.shR) * st, dM = Math.exp(-h / ATM.shM) * st;
    odR += dR; odM += dM;
    const gs = rsiJS(px, py, pz, sun, ATM.rP);
    if (gs && gs[0] > 0) continue;
    const sj = rsiJS(px, py, pz, sun, ATM.rA)[1] / M;
    let jR = 0, jM = 0;
    for (let j = 0; j < M; j++) {
      const tj = sj * (j + 0.5);
      const hj = Math.hypot(px + sun.x * tj, py + sun.y * tj, pz + sun.z * tj) - ATM.rP;
      jR += Math.exp(-hj / ATM.shR) * sj; jM += Math.exp(-hj / ATM.shM) * sj;
    }
    for (let c = 0; c < 3; c++) {
      const a = Math.exp(-(ATM.kM * 1.1 * (odM + jM) + (ATM.kR[c] + ATM.kO[c]) * (odR + jR)));
      totR[c] += dR * a; totM[c] += dM * a;
    }
  }
  for (let c = 0; c < 3; c++) out[c] += iSun * (pR * ATM.kR[c] * totR[c] + pM * ATM.kM * totM[c]);
  return out;
}
// colour of sunlight after passing through the atmosphere to the viewer
export function sunTransmittance(sun, out) {
  if (sun.y < -0.02) { out[0] = out[1] = out[2] = 0; return out; }
  const s = { x: sun.x, y: Math.max(sun.y, 0.0), z: sun.z };
  const len = rsiJS(0, ATM.eye, 0, s, ATM.rA)[1], N = 12, st = len / N;
  let odR = 0, odM = 0;
  for (let i = 0; i < N; i++) {
    const t = st * (i + 0.5);
    const h = Math.hypot(s.x * t, ATM.eye + s.y * t, s.z * t) - ATM.rP;
    odR += Math.exp(-h / ATM.shR) * st; odM += Math.exp(-h / ATM.shM) * st;
  }
  for (let c = 0; c < 3; c++) out[c] = Math.exp(-((ATM.kR[c] + ATM.kO[c]) * odR + ATM.kM * 1.1 * odM));
  return out;
}
export const SKY_EXPOSURE = 5.0, MS_FILL = [0.02, 0.05, 0.12];
// same tone curve as the sky shader; rgb in, rgb (display values) out
export function toneMapSky(c) {
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const k = L > 0 ? (1 - Math.exp(-SKY_EXPOSURE * L)) / L : 0;
  const t = c.map(v => (1 - Math.exp(-SKY_EXPOSURE * v)) * 0.25 + Math.min(1, v * k) * 0.75);
  const tl = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
  return t.map(v => clamp(tl + (v - tl) * 1.15, 0, 1));
}

// sun disc with limb darkening + corona glow (HDR so it blooms)
export const sunDisc = new THREE.Mesh(new THREE.PlaneGeometry(130, 130), new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
  uniforms: { color: { value: new THREE.Color(1, 1, 1) }, glow: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform vec3 color; uniform float glow; varying vec2 vUv;
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p), R = 0.12;
      float disc = smoothstep(R, R * 0.94, r);
      float mu = sqrt(max(0.0, 1.0 - (r / R) * (r / R)));
      float limb = 0.35 + 0.65 * pow(mu, 0.45);
      vec3 c = color * disc * limb * 9.0;
      c += color * (exp(-r * 9.0) * 0.18 + exp(-r * 28.0) * 0.6) * glow;
      gl_FragColor = vec4(c, 1.0);
    }`,
}));
sunDisc.renderOrder = -1;
scene.add(sunDisc);

export const moonDisc = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
  uniforms: { alpha: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform float alpha; varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p), R = 0.28;
      float disc = smoothstep(R, R * 0.95, r);
      float maria = n(p * 7.0) * 0.6 + n(p * 15.0) * 0.4;           // dark "seas" on the moon
      vec3 surf = vec3(0.92, 0.94, 1.0) * (0.75 + 0.35 * smoothstep(0.35, 0.75, maria));
      vec3 c = surf * disc * 1.4 + vec3(0.6, 0.7, 1.0) * exp(-r * 5.0) * 0.25;
      gl_FragColor = vec4(c * alpha, 1.0);
    }`,
}));
moonDisc.renderOrder = -1;
scene.add(moonDisc);

// stars: twinkling points on a sphere that turns with the sky
const starGeo = new THREE.BufferGeometry();
{
  const n = 1800, pos = new Float32Array(n * 3), size = new Float32Array(n), phase = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos.set([Math.cos(a) * r * 440, u * 440, Math.sin(a) * r * 440], i * 3);
    size[i] = 1 + Math.pow(Math.random(), 6) * 3.5;
    phase[i] = Math.random();
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  starGeo.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
}
export const stars = new THREE.Points(starGeo, new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  uniforms: { alpha: { value: 0 }, time: { value: 0 }, pr: { value: renderer.getPixelRatio() } },
  vertexShader: `
    attribute float size; attribute float phase; uniform float alpha; uniform float time; uniform float pr; varying float vA;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewMatrix * wp;
      gl_PointSize = size * pr * 1.6;
      float up = normalize(wp.xyz - cameraPosition).y;
      vA = alpha * (0.6 + 0.4 * sin(time * (1.0 + phase * 3.0) + phase * 40.0)) * smoothstep(-0.02, 0.2, up);
    }`,
  fragmentShader: `
    varying float vA;
    void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vec3(1.0, 0.96, 0.9) * smoothstep(0.5, 0.0, d) * vA, 1.0); }`,
}));
stars.renderOrder = -2;
scene.add(stars);

// ---------------------------------------------------------------- lights
export const hemi = new THREE.HemisphereLight(0xffffff, 0x667744, 1.0);
scene.add(hemi);
export const sunLight = new THREE.DirectionalLight(0xffffff, 2);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
Object.assign(sunLight.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 320 });
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.05;
scene.add(sunLight, sunLight.target);
