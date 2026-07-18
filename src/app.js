import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

// ----------------------------------------------------------------------------
// Load baked data (gzipped Int16 elevation + Uint8 country-id grid)
// ----------------------------------------------------------------------------
const meta = await fetch('./data/region_elevation.json').then(r => r.json());
const gz = await fetch('./data/region_elevation.bin.gz').then(r => r.arrayBuffer());
const binBuf = await new Response(
  new Response(gz).body.pipeThrough(new DecompressionStream('gzip'))
).arrayBuffer();
const { cols, rows, elevMax } = meta;
const elev = new Int16Array(binBuf, 0, cols * rows);
const cid = new Uint8Array(binBuf, cols * rows * 2, cols * rows);

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
scene.background = new THREE.Color(0xf4f1ea);

const W = cols, H = rows;
const DIAG = Math.hypot(W, H);
const VIEW_DIR = new THREE.Vector3(-0.5, 0.72, 0.9).normalize();

// ----------------------------------------------------------------------------
// Cameras
// ----------------------------------------------------------------------------
const persp = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 1, DIAG * 10);
const orthoBase = DIAG * 0.62;
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -DIAG * 6, DIAG * 10);
let camera = ortho;

function frameCameras() {
  const a = innerWidth / innerHeight;
  ortho.left = -orthoBase * a; ortho.right = orthoBase * a;
  ortho.top = orthoBase; ortho.bottom = -orthoBase;
  ortho.updateProjectionMatrix();
  persp.aspect = a; persp.updateProjectionMatrix();
}
frameCameras();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;

// ----------------------------------------------------------------------------
// Lights
// ----------------------------------------------------------------------------
const sun = new THREE.DirectionalLight(0xfff3e0, 2.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, {
  left: -W * 0.62, right: W * 0.62, top: H * 0.62, bottom: -H * 0.62, near: 1, far: DIAG * 5,
});
sun.shadow.bias = -0.0006;
scene.add(sun, sun.target);

const ambient = new THREE.HemisphereLight(0xffffff, 0x8a7f6a, 0.85);
scene.add(ambient);

const shadowPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(W * 4, H * 4),
  new THREE.ShadowMaterial({ opacity: 0.22 })
);
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.position.y = 0.01;
shadowPlane.receiveShadow = true;
scene.add(shadowPlane);

// ----------------------------------------------------------------------------
// Colour map (hypsometric, warm) — normalised to the region's max elevation
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
      cA.setHex(c0); cB.setHex(c1);
      return cOut.copy(cA).lerp(cB, (t - p0) / (p1 - p0));
    }
  }
  return cOut.setHex(STOPS.at(-1)[1]);
}
const NORM = elevMax * 0.98;

// ----------------------------------------------------------------------------
// Terrain instanced mesh
// ----------------------------------------------------------------------------
const V_SCALE = 20 / 1000;
const BASE = 2.5;
const GAP = 0.92;

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
boxGeo.translate(0, 0.5, 0);
const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.0 });

let mesh = null;
const state = { factor: 4, exag: 1.5, sat: 1.15, country: 0 };
const _m = new THREE.Matrix4();
const _hsl = { h: 0, s: 0, l: 0 };

function build() {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.dispose(); }
  const f = state.factor, sel = state.country;
  const oc = Math.ceil(cols / f), orr = Math.ceil(rows / f);
  const blocks = [];
  const counts = new Uint16Array(64);

  for (let br = 0; br < orr; br++) {
    for (let bc = 0; bc < oc; bc++) {
      counts.fill(0);
      let tot = 0, land = 0, sum = 0;
      for (let dr = 0; dr < f; dr++) {
        const r = br * f + dr; if (r >= rows) break;
        for (let dc = 0; dc < f; dc++) {
          const c = bc * f + dc; if (c >= cols) break;
          const i = r * cols + c; tot++;
          const id = cid[i];
          if (id) { land++; sum += elev[i]; if (id < 64) counts[id]++; }
        }
      }
      if (land < tot * 0.5 || land === 0) continue;
      // dominant country in this block
      let dom = 0, best = 0;
      for (let k = 1; k < 64; k++) if (counts[k] > best) { best = counts[k]; dom = k; }
      if (sel !== 0 && dom !== sel) continue;
      const e = sum / land;
      const cx = (bc * f + f / 2) - cols / 2;
      const cz = (br * f + f / 2) - rows / 2;
      blocks.push(cx, cz, e);
    }
  }

  const n = blocks.length / 3;
  mesh = new THREE.InstancedMesh(boxGeo, mat, n);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  const vs = V_SCALE * state.exag;
  const foot = f * GAP;
  for (let k = 0; k < n; k++) {
    const cx = blocks[k * 3], cz = blocks[k * 3 + 1], e = blocks[k * 3 + 2];
    _m.makeScale(foot, BASE + Math.max(0, e) * vs, foot);
    _m.setPosition(cx, 0, cz);
    mesh.setMatrixAt(k, _m);
    const col = ramp(e / NORM);
    col.getHSL(_hsl);
    col.setHSL(_hsl.h, Math.min(1, _hsl.s * state.sat), _hsl.l);
    mesh.setColorAt(k, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  window.__dbg = { count: n, factor: f, country: sel };
  document.getElementById('loading').style.display = 'none';
}

// ----------------------------------------------------------------------------
// Camera framing (cell = [cmin,rmin,cmax,rmax] in full-res cells, or null=all)
// ----------------------------------------------------------------------------
let currentCell = null;
function frameTo(cell) {
  currentCell = cell;
  let cx, cz, S;
  if (cell) {
    cx = (cell[0] + cell[2]) / 2 - cols / 2;
    cz = (cell[1] + cell[3]) / 2 - rows / 2;
    S = Math.max(cell[2] - cell[0], cell[3] - cell[1]);
  } else { cx = 0; cz = 0; S = Math.max(cols, rows); }
  const tgt = new THREE.Vector3(cx, 8, cz);
  if (camera.isOrthographicCamera) {
    camera.zoom = Math.max(0.35, Math.min(9, (DIAG * 1.1) / (S * 1.3)));
    camera.position.copy(tgt).addScaledVector(VIEW_DIR, DIAG * 1.6);
    camera.updateProjectionMatrix();
  } else {
    camera.position.copy(tgt).addScaledVector(VIEW_DIR, S * 1.7 + 60);
  }
  controls.target.copy(tgt);
  controls.update();
}

// ----------------------------------------------------------------------------
// UI
// ----------------------------------------------------------------------------
const $ = id => document.getElementById(id);

// populate country selector (sorted by name)
const regionSel = $('region');
[...meta.countries].filter(c => c.cell).sort((a, b) => a.name.localeCompare(b.name)).forEach(c => {
  const o = document.createElement('option');
  o.value = c.id; o.textContent = c.name; regionSel.appendChild(o);
});
regionSel.addEventListener('change', () => {
  state.country = parseInt(regionSel.value, 10);
  const c = meta.countries.find(x => x.id === state.country);
  $('loading').style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    build();
    frameTo(c ? c.cell : null);
  }));
});

// legend ticks from elevMax
const tickEls = $('ticks').children;
for (let i = 0; i < 5; i++) {
  const v = Math.round((elevMax * i / 4) / 100) * 100;
  tickEls[i].textContent = i === 0 ? '0 m' : (i === 4 ? v + '+' : v);
}

function bindSlider(id, fmt, onChange) {
  const el = $(id), out = $(id + 'V');
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    if (out) out.textContent = fmt(v);
    onChange(v);
  });
}
bindSlider('exag', v => v.toFixed(2).replace(/0$/, ''), v => { state.exag = v; build(); });
bindSlider('sat', v => v.toFixed(2), v => { state.sat = v; build(); });
bindSlider('sun', v => v.toFixed(2), v => { sun.intensity = v; });
bindSlider('amb', v => v.toFixed(2), v => { ambient.intensity = v; });
bindSlider('azm', v => v | 0, updateSun);
bindSlider('elv', v => v | 0, updateSun);
bindSlider('soft', v => v | 0, v => {
  const s = 1024 + v * 512;
  sun.shadow.mapSize.set(s, s);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
});

function updateSun() {
  const az = parseFloat($('azm').value) * Math.PI / 180;
  const el = parseFloat($('elv').value) * Math.PI / 180;
  const r = DIAG * 1.8;
  sun.position.set(Math.cos(el) * Math.sin(az) * r, Math.sin(el) * r, Math.cos(el) * Math.cos(az) * r);
  sun.target.position.set(0, 0, 0);
}
updateSun();

$('shadows').addEventListener('change', e => {
  renderer.shadowMap.enabled = e.target.checked;
  sun.castShadow = e.target.checked;
  shadowPlane.visible = e.target.checked;
  scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
});

$('projection').addEventListener('change', e => {
  const pos = camera.position.clone(), tgt = controls.target.clone();
  camera = e.target.value === 'persp' ? persp : ortho;
  camera.position.copy(pos);
  controls.object = camera;
  controls.target.copy(tgt);
  frameTo(currentCell);   // re-fit the current selection for the new projection
});

document.querySelectorAll('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.factor = parseInt(btn.dataset.res, 10);
    $('loading').style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(build));
  });
});

// ----------------------------------------------------------------------------
// Export transparent 4K PNG
// ----------------------------------------------------------------------------
$('export').addEventListener('click', () => {
  const btn = $('export'); btn.disabled = true; btn.textContent = 'rendering…';
  const prevBg = scene.background, dpr = renderer.getPixelRatio();
  const target = 3840, a = innerWidth / innerHeight;
  const w = a >= 1 ? target : Math.round(target * a);
  const h = a >= 1 ? Math.round(target / a) : target;
  scene.background = null;
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  if (camera.isPerspectiveCamera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  renderer.render(scene, camera);
  renderer.domElement.toBlob(blob => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'middle-east-terrain-4k.png';
    link.click();
    URL.revokeObjectURL(link.href);
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
  hud.zoom.textContent = (camera.isOrthographicCamera ? camera.zoom : DIAG / p.distanceTo(t)).toFixed(2);
}

addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); frameCameras(); });

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

build();
frameTo(null);
tick();
