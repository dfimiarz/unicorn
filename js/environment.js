import * as THREE from 'three';
import { H, WATER } from './config.js';
import { scene } from './render.js';
import { skyTarget } from './sky.js';
import { rand } from './world.js';

// The sea, the sea floor and the clouds.
export const waterMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    sunDir: { value: new THREE.Vector3() }, sunColor: { value: new THREE.Color() },
    ambient: { value: new THREE.Color() }, time: { value: 0 },
  }]),
  vertexShader: `
    varying vec3 vWorld;
    #include <fog_pars_vertex>
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: `
    #define OCEAN_RADIUS 480.0
    uniform samplerCube skyCube; uniform vec3 sunDir; uniform vec3 sunColor; uniform vec3 ambient; uniform float time;
    varying vec3 vWorld;
    #include <common>
    #include <fog_pars_fragment>
    vec2 wave(vec2 p, vec2 d, float k, float a, float s) { float ph = dot(d, p) * k + time * s; return d * (a * k * cos(ph)); }
    void main() {
      vec2 p = vWorld.xz;
      vec2 g = wave(p, normalize(vec2(1.0, 0.3)), 0.55, 0.08, 1.3)
             + wave(p, normalize(vec2(-0.4, 1.0)), 0.9, 0.05, 1.7)
             + wave(p, normalize(vec2(0.7, -0.8)), 1.7, 0.025, 2.4)
             + wave(p, normalize(vec2(-1.0, -0.2)), 3.1, 0.012, 3.3)
             + wave(p, normalize(vec2(0.2, 1.0)), 5.3, 0.007, 4.1)
             + wave(p, normalize(vec2(0.9, 0.5)), 8.7, 0.004, 5.3);
      float dist = length(cameraPosition - vWorld);
      g *= 1.0 / (1.0 + dist * 0.004);
      vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
      vec3 V = normalize(cameraPosition - vWorld);
      vec3 deep = vec3(0.02, 0.09, 0.16) * ambient;
      if (!gl_FrontFacing) { gl_FragColor = vec4(deep * 2.0, 0.65); return; }
      vec3 R = reflect(-V, N); R.y = abs(R.y);
      vec3 sky = textureCube(skyCube, R).rgb;
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
      vec3 col = mix(deep, sky, fres);
      // sun glitter: a tight HDR highlight plus a broader sheen
      vec3 Hh = normalize(sunDir + V);
      float nh = max(dot(N, Hh), 0.0);
      col += sunColor * (pow(nh, 900.0) * 60.0 + pow(nh, 90.0) * 0.6);
      gl_FragColor = vec4(col, mix(0.72, 0.97, fres));
      // fade into the haze over a longer distance than the land so the open sea keeps its reflections
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(fogNear * 1.5, OCEAN_RADIUS, vFogDepth));
    }`,
});
waterMat.uniforms.skyCube = { value: skyTarget.texture };
// the sea is a big disc that follows the camera, so it always reaches the horizon
const OCEAN_RADIUS = 490;
export const water = new THREE.Mesh(new THREE.CircleGeometry(OCEAN_RADIUS, 96), waterMat);
water.rotation.x = -Math.PI / 2;
water.position.set(0, WATER + 0.9, 0);
water.renderOrder = 2;
scene.add(water);
export const seaFloor = new THREE.Mesh(new THREE.CircleGeometry(OCEAN_RADIUS, 64), new THREE.MeshLambertMaterial({ color: 0xb8a77a }));
seaFloor.rotation.x = -Math.PI / 2;
seaFloor.position.set(0, WATER - 5.1, 0);
scene.add(seaFloor);

// clouds: lit by the sun so they glow at sunrise/sunset, and they cast drifting shadows.
// They wrap around inside a square that follows the player.
const CLOUD_SPAN = 480;
const clouds = new THREE.Group();
export const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, fog: false });
for (let i = 0; i < 30; i++) {
  const c = new THREE.Mesh(new THREE.BoxGeometry(8 + rand() * 16, 2, 6 + rand() * 12), cloudMat);
  c.position.set((rand() - 0.5) * CLOUD_SPAN, H + 12 + rand() * 6, (rand() - 0.5) * CLOUD_SPAN);
  c.castShadow = true;
  clouds.add(c);
}
scene.add(clouds);

// drift the clouds, wrapping them around inside the square centred on pos
export function updateClouds(dt, pos) {
  for (const c of clouds.children) {
    c.position.x += dt * 1.5;
    const dx = c.position.x - pos.x, dz = c.position.z - pos.z;
    if (Math.abs(dx) > CLOUD_SPAN / 2) c.position.x -= Math.sign(dx) * CLOUD_SPAN;
    if (Math.abs(dz) > CLOUD_SPAN / 2) c.position.z -= Math.sign(dz) * CLOUD_SPAN;
  }
}
