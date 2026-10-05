import * as THREE from 'three';

// Renderer, main scene and camera.
export const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // updated once per frame, not for the extra sky/mask passes
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8ecdf5, 45, 130);

export const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 500);
camera.rotation.order = 'YXZ';
