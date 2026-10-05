import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { renderer, scene, camera } from './render.js';
import { sunDisc, moonDisc, stars } from './sky.js';
import { highlight, target } from './camera.js';

// Post-processing (god rays + bloom) and resizing.

const quadVertex = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// The scene is drawn with 4× MSAA into a target of its own, then copied once into the composer's
// buffers, which have no MSAA. Every full-screen pass that writes into a multisampled buffer pays
// for a resolve afterwards, which made god rays and bloom several times more expensive.
class SceneMsaaPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene; this.camera = camera;
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.copy = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
      depthTest: false, depthWrite: false,
    }));
    this.copy.material.uniforms.tDiffuse.value = this.target.texture;
  }
  setSize(w, h) { this.target.setSize(w, h); }
  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.copy.render(renderer);
  }
  dispose() { this.target.dispose(); this.copy.dispose(); }
}

// God rays are worked out at a quarter of the screen resolution (the sky mask they march over is
// already that small) and then added onto the full-resolution image.
const raysMat = new THREE.ShaderMaterial({
  uniforms: { tMask: { value: null }, sunPos: { value: new THREE.Vector2(0.5, 0.5) }, aspect: { value: 1 } },
  vertexShader: quadVertex,
  fragmentShader: `
    uniform sampler2D tMask; uniform vec2 sunPos; uniform float aspect;
    varying vec2 vUv;
    #define SAMPLES 64
    void main() {
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
      gl_FragColor = vec4(vec3(acc / float(SAMPLES)), 1.0);
    }`,
  depthTest: false, depthWrite: false,
});
const raysQuad = new FullScreenQuad(raysMat);
const godRays = new ShaderPass(new THREE.ShaderMaterial({
  uniforms: { tDiffuse: { value: null }, tRays: { value: null }, color: { value: new THREE.Color() }, intensity: { value: 0 } },
  vertexShader: quadVertex,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform sampler2D tRays; uniform vec3 color; uniform float intensity;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(base.rgb + color * texture2D(tRays, vUv).r * intensity, base.a);
    }`,
}));
godRays.enabled = false;

// Called every frame by the day/night cycle. With intensity 0 the effect is switched off entirely:
// no sky mask, no ray march, and no extra full-screen pass.
export function setGodRays(intensity, color, sunX, sunY, aspect) {
  godRays.enabled = intensity > 0;
  if (!godRays.enabled) return;
  godRays.uniforms.intensity.value = intensity;
  godRays.uniforms.color.value.copy(color);
  raysMat.uniforms.sunPos.value.set(sunX, sunY);
  raysMat.uniforms.aspect.value = aspect;
}

export const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, depthBuffer: false }));
composer.addPass(new SceneMsaaPass(scene, camera));
composer.addPass(godRays);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.4, 1.05); // only HDR highlights bloom
composer.addPass(bloom);
composer.addPass(new OutputPass());

// low-res mask of where open sky is visible (everything else black), and the rays marched over it
const maskTarget = new THREE.WebGLRenderTarget(1, 1);
const raysTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
raysMat.uniforms.tMask.value = maskTarget.texture;
godRays.uniforms.tRays.value = raysTarget.texture;
const maskMat = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
const prevClear = new THREE.Color();
// call before composer.render(); does nothing while the god rays are off
export function renderGodRays() {
  if (!godRays.enabled) return;
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
  renderer.setClearColor(prevClear, prevAlpha);
  scene.overrideMaterial = null;
  scene.background = bg;
  stars.visible = starsVis; sunDisc.visible = sunVis; moonDisc.visible = true; highlight.visible = !!target;
  renderer.setRenderTarget(raysTarget);
  raysQuad.render(renderer);
  renderer.setRenderTarget(null);
}

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  const pr = renderer.getPixelRatio();
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  const qw = Math.ceil(innerWidth * pr / 4), qh = Math.ceil(innerHeight * pr / 4);
  maskTarget.setSize(qw, qh);
  raysTarget.setSize(qw, qh);
  stars.material.uniforms.pr.value = pr;
}
addEventListener('resize', resize);
resize();
