import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { renderer, scene, camera } from './render.js';
import { sunDisc, moonDisc, stars } from './sky.js';
import { highlight, target } from './camera.js';

// Post-processing (god rays + bloom) and resizing.
const GodRaysShader = {
  uniforms: {
    tDiffuse: { value: null }, tMask: { value: null }, sunPos: { value: new THREE.Vector2(0.5, 0.5) },
    color: { value: new THREE.Color() }, intensity: { value: 0 }, aspect: { value: 1 },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform sampler2D tMask;
    uniform vec2 sunPos; uniform vec3 color; uniform float intensity; uniform float aspect;
    varying vec2 vUv;
    #define SAMPLES 64
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (intensity <= 0.0) { gl_FragColor = base; return; }
      // march toward the sun, adding up open sky that sits near the sun (screen-space light shafts)
      vec2 delta = (vUv - sunPos) / float(SAMPLES) * 0.97;
      float jitter = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
      vec2 tc = vUv - delta * jitter;
      float illum = 1.0, acc = 0.0;
      for (int i = 0; i < SAMPLES; i++) {
        tc -= delta;
        vec2 d = (tc - sunPos) * vec2(aspect, 1.0);
        acc += texture2D(tMask, clamp(tc, 0.001, 0.999)).r * exp(-dot(d, d) * 14.0) * illum;
        illum *= 0.968;
      }
      acc /= float(SAMPLES);
      gl_FragColor = vec4(base.rgb + color * acc * intensity, base.a);
    }`,
};
export const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
export const godRays = new ShaderPass(GodRaysShader);
composer.addPass(godRays);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.4, 1.05); // only HDR highlights bloom
composer.addPass(bloom);
composer.addPass(new OutputPass());

// low-res mask of where open sky is visible (everything else black), used by the god rays
const maskTarget = new THREE.WebGLRenderTarget(1, 1);
godRays.uniforms.tMask.value = maskTarget.texture;
const maskMat = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
const prevClear = new THREE.Color();
export function renderRayMask() {
  const bg = scene.background, starsVis = stars.visible, sunVis = sunDisc.visible;
  scene.background = null;
  scene.overrideMaterial = maskMat;
  sunDisc.visible = moonDisc.visible = stars.visible = highlight.visible = false;
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0xffffff, 1);
  renderer.setRenderTarget(maskTarget);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.setClearColor(prevClear, prevAlpha);
  scene.overrideMaterial = null;
  scene.background = bg;
  stars.visible = starsVis; sunDisc.visible = sunVis; moonDisc.visible = true; highlight.visible = !!target;
}

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  const pr = renderer.getPixelRatio();
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  maskTarget.setSize(Math.ceil(innerWidth * pr / 4), Math.ceil(innerHeight * pr / 4));
  stars.material.uniforms.pr.value = pr;
}
addEventListener('resize', resize);
resize();
