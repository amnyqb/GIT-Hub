import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

// ----------------------------------------------------------------------------
// Load baked data
// ----------------------------------------------------------------------------
const meta = await fetch('./data/saudi_elevation.json').then(r => r.json());
const binBuf = await fetch('./data/saudi_elevation.bin').then(r => r.arrayBuffer());
const { cols, rows, elevMax } = meta;
const elev = new Int16Array(binBuf, 0, cols * rows);
const mask = new Uint8Array(binBuf, cols * rows * 2, cols * rows);

// ----------------------------------------------------------------------------
// Scene / renderer
// ----------------------------------------------------------------------------
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SCREEN_BG = new THREE.Color(0xf4f1ea);
scene.background = SCREEN_BG;

// world extent (1 unit == 1 input cell; cells are metrically square)
const W = cols, H = rows;
const DIAG = Math.hypot(W, H);

// ----------------------------------------------------------------------------
// Cameras
// ----------------------------------------------------------------------------
const persp = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 1, DIAG * 8);
const orthoZoomBase = DIAG * 0.62;
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -DIAG * 4, DIAG * 8);
let camera = ortho;

function frameCameras() {
  const aspect = innerWidth / innerHeight;
  ortho.left = -orthoZoomBase * aspect; ortho.right = orthoZoomBase * aspect;
  ortho.top = orthoZoomBase; ortho.bottom = -orthoZoomBase;
  ortho.updateProjectionMatrix();
  persp.aspect = aspect; persp.updateProjectionMatrix();
}
const startPos = new THREE.Vector3(-W * 0.55, DIAG * 0.7, H * 0.95);
persp.position.copy(startPos); ortho.position.copy(startPos);
frameCameras();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);
controls.maxPolarAngle = Math.PI * 0.495;

// ----------------------------------------------------------------------------
// Lights
// ----------------------------------------------------------------------------
const sun = new THREE.DirectionalLight(0xfff3e0, 2.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -W * 0.62; sc.right = W * 0.62; sc.top = H * 0.62; sc.bottom = -H * 0.62;
sc.near = 1; sc.far = DIAG * 4;
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(sun.target);

const ambient = new THREE.HemisphereLight(0xffffff, 0x8a7f6a, 0.85);
scene.add(ambient);

// soft drop shadow beneath the country footprint (like the reference)
const shadowPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(W * 3, H * 3),
  new THREE.ShadowMaterial({ opacity: 0.22 })
);
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.position.y = 0.01;
shadowPlane.receiveShadow = true;
scene.add(shadowPlane);

// ----------------------------------------------------------------------------
// Colour map (hypsometric, warm)
// ----------------------------------------------------------------------------
const STOPS = [
  [0.00, 0x1b6b7a], [0.10, 0x2e8b8b], [0.28, 0x7fae6e],
  [0.48, 0xcdb46a], [0.66, 0xd98f4e], [0.84, 0xb5603a], [1.00, 0xf2e4d0],
];
const cA = new THREE.Color(), cB = new THREE.Color(), cOut = new THREE.Color();
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [p0, c0] = STOPS[i - 1], [p1, c1] = STOPS[i];
      const f = (t - p0) / (p1 - p0);
      cA.setHex(c0); cB.setHex(c1);
      return cOut.copy(cA).lerp(cB, f);
    }
  }
  return cOut.setHex(STOPS[STOPS.length - 1][1]);
}

// ----------------------------------------------------------------------------
// Terrain instanced mesh
// ----------------------------------------------------------------------------
const V_SCALE = 20 / 1000;   // world units per metre, before exaggeration
const BASE = 2.5;            // slab thickness so 0 m land is still visible
const GAP = 0.9;             // block footprint fraction

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
boxGeo.translate(0, 0.5, 0);  // pivot at base, grows upward
const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.0 });

let mesh = null;
let state = { factor: 4, exag: 1.5, sat: 1.15 };

const _m = new THREE.Matrix4();
const _hsl = { h: 0, s: 0, l: 0 };

function build(factor) {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.dispose(); }

  const oc = Math.ceil(cols / factor), orr = Math.ceil(rows / factor);
  // first pass: gather land blocks
  const blocks = [];
  for (let br = 0; br < orr; br++) {
    for (let bc = 0; bc < oc; bc++) {
      let land = 0, tot = 0, sum = 0;
      for (let dr = 0; dr < factor; dr++) {
        const r = br * factor + dr; if (r >= rows) break;
        for (let dc = 0; dc < factor; dc++) {
          const c = bc * factor + dc; if (c >= cols) break;
          const i = r * cols + c; tot++;
          if (mask[i]) { land++; sum += elev[i]; }
        }
      }
      if (land >= tot * 0.5 && land > 0) {
        const e = sum / land;
        // world center: x grows east, z grows south (row0 = north)
        const cx = (bc * factor + factor / 2) - cols / 2;
        const cz = (br * factor + factor / 2) - rows / 2;
        blocks.push([cx, cz, e]);
      }
    }
  }

  mesh = new THREE.InstancedMesh(boxGeo, mat, blocks.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(blocks.length * 3), 3);

  const vs = V_SCALE * state.exag;
  const foot = factor * GAP;
  for (let k = 0; k < blocks.length; k++) {
    const [cx, cz, e] = blocks[k];
    const h = BASE + Math.max(0, e) * vs;
    _m.makeScale(foot, h, foot);
    _m.setPosition(cx, 0, cz);
    mesh.setMatrixAt(k, _m);

    const col = ramp(e / (elevMax * 0.98));
    col.getHSL(_hsl);
    col.setHSL(_hsl.h, Math.min(1, _hsl.s * state.sat), _hsl.l);
    mesh.setColorAt(k, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  window.__dbg = { count: blocks.length, factor };
  document.getElementById('loading').style.display = 'none';
}

// update only heights (exaggeration) without rebuilding block list — cheap-ish rebuild
function rebuild() { build(state.factor); }

build(state.factor);

// ----------------------------------------------------------------------------
// UI wiring
// ----------------------------------------------------------------------------
const $ = id => document.getElementById(id);
function bindSlider(id, key, fmt = v => v, onChange) {
  const el = $(id), out = $(id + 'V');
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    if (out) out.textContent = fmt(v);
    onChange(v);
  });
}

bindSlider('exag', 'exag', v => v.toFixed(2).replace(/0$/, ''), v => { state.exag = v; rebuild(); });
bindSlider('sat', 'sat', v => v.toFixed(2), v => { state.sat = v; rebuild(); });
bindSlider('azm', null, v => v | 0, updateSun);
bindSlider('elv', null, v => v | 0, updateSun);
bindSlider('sun', null, v => v.toFixed(2), v => { sun.intensity = v; });
bindSlider('amb', null, v => v.toFixed(2), v => { ambient.intensity = v; });
bindSlider('soft', null, v => v | 0, v => {
  const s = 1024 + v * 512;
  sun.shadow.mapSize.set(s, s);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
});

function updateSun() {
  const az = parseFloat($('azm').value) * Math.PI / 180;
  const el = parseFloat($('elv').value) * Math.PI / 180;
  const r = DIAG * 1.6;
  sun.position.set(
    Math.cos(el) * Math.sin(az) * r,
    Math.sin(el) * r,
    Math.cos(el) * Math.cos(az) * r
  );
  sun.target.position.set(0, 0, 0);
}
updateSun();

$('shadows').addEventListener('change', e => {
  renderer.shadowMap.enabled = e.target.checked;
  sun.castShadow = e.target.checked;
  shadowPlane.visible = e.target.checked;
  scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
});

// projection toggle
$('projection').addEventListener('change', e => {
  const persist = camera.position.clone(), tgt = controls.target.clone();
  camera = e.target.value === 'persp' ? persp : ortho;
  camera.position.copy(persist);
  controls.object = camera;
  controls.target.copy(tgt);
  controls.update();
});

// resolution tabs
document.querySelectorAll('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.factor = parseInt(btn.dataset.res, 10);
    $('loading').style.display = 'flex';
    // let the loader paint before the (blocking) rebuild
    requestAnimationFrame(() => requestAnimationFrame(rebuild));
  });
});

// ----------------------------------------------------------------------------
// Export transparent 4K PNG
// ----------------------------------------------------------------------------
$('export').addEventListener('click', () => {
  const btn = $('export'); btn.disabled = true; btn.textContent = 'rendering…';
  const prevBg = scene.background;
  const target = 3840;
  const aspect = innerWidth / innerHeight;
  const w = aspect >= 1 ? target : Math.round(target * aspect);
  const h = aspect >= 1 ? Math.round(target / aspect) : target;
  const dpr = renderer.getPixelRatio();
  scene.background = null;
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect && (camera.aspect = w / h, camera.updateProjectionMatrix());
  renderer.render(scene, camera);
  renderer.domElement.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'saudi-terrain-4k.png';
    a.click();
    URL.revokeObjectURL(a.href);
    // restore
    scene.background = prevBg;
    renderer.setPixelRatio(dpr);
    renderer.setSize(innerWidth, innerHeight, false);
    frameCameras();
    btn.disabled = false; btn.textContent = 'export transparent PNG (4K)';
  }, 'image/png');
});

// ----------------------------------------------------------------------------
// HUD + resize + loop
// ----------------------------------------------------------------------------
const hud = { cx: $('cx'), cy: $('cy'), cz: $('cz'), tx: $('tx'), ty: $('ty'), tz: $('tz'), zoom: $('zoom') };
function updateHud() {
  const p = camera.position, t = controls.target;
  hud.cx.textContent = p.x | 0; hud.cy.textContent = p.y | 0; hud.cz.textContent = p.z | 0;
  hud.tx.textContent = t.x | 0; hud.ty.textContent = t.y | 0; hud.tz.textContent = t.z | 0;
  hud.zoom.textContent = (camera.isOrthographicCamera ? camera.zoom : (DIAG / p.distanceTo(t))).toFixed(2);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  frameCameras();
});

// running timer badge
const t0 = performance.now();
const timerEl = $('timer');
function tick() {
  requestAnimationFrame(tick);
  controls.update();
  updateHud();
  const s = (performance.now() - t0) / 1000 | 0;
  timerEl.textContent = `${String(s / 60 | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  renderer.render(scene, camera);
}
tick();
