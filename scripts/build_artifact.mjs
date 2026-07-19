#!/usr/bin/env node
// Generate a fully self-contained single-file build of the app:
// three.js, OrbitControls, the elevation data, and app code inlined into one
// HTML file with no external requests. Used for the claude.ai artifact and as
// a portable "just open it" build in dist/.
//
// three.module.js is kept as module-top-level source (its `export`s are inert
// here). OrbitControls is wrapped in an IIFE so its module-level temporaries
// (_ray, _plane, ...) don't collide with three's. A THREE namespace object is
// assembled from three's top-level bindings so the app keeps using `THREE.*`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const r = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// names the app + OrbitControls reference from three
const THREE_NAMES = [
  'WebGLRenderer', 'Scene', 'Color', 'PerspectiveCamera', 'OrthographicCamera',
  'DirectionalLight', 'HemisphereLight', 'Mesh', 'PlaneGeometry', 'ShadowMaterial',
  'BoxGeometry', 'MeshStandardMaterial', 'InstancedMesh', 'InstancedBufferAttribute',
  'Matrix4', 'Vector2', 'Vector3', 'PCFSoftShadowMap', 'SRGBColorSpace',
  'EventDispatcher', 'MOUSE', 'TOUCH', 'Quaternion', 'Spherical', 'Plane', 'Ray', 'MathUtils',
];
const ORBIT_NAMES = ['EventDispatcher', 'MOUSE', 'Quaternion', 'Spherical', 'TOUCH', 'Vector2', 'Vector3', 'Plane', 'Ray', 'MathUtils'];

const three = r('src/vendor/three.module.js');
const threeNs = `\nconst THREE = { ${THREE_NAMES.join(', ')} };\n`;

const orbitSrc = r('src/vendor/OrbitControls.js')
  .replace(/^import \{[\s\S]*?\} from '\.\/three\.module\.js';\n/m, '')
  .replace(/^export \{ OrbitControls \};\s*$/m, '');
const orbit = `const OrbitControls = (function () {\nconst { ${ORBIT_NAMES.join(', ')} } = THREE;\n${orbitSrc}\nreturn OrbitControls;\n})();\n`;

// data
const metaJson = r('data/region_elevation.json').trim();
const gzB64 = fs.readFileSync(path.join(ROOT, 'data/region_elevation.bin.gz')).toString('base64');

// app: drop imports, inline data (keep THREE.* namespace), wrap in async IIFE
let app = r('src/app.js')
  .replace(/^import \* as THREE from '\.\/vendor\/three\.module\.js';\n/m, '')
  .replace(/^import \{ OrbitControls \} from '\.\/vendor\/OrbitControls\.js';\n/m, '')
  .replace(
    /const meta = await fetch[\s\S]*?\)\.arrayBuffer\(\);/,
    `const meta = ${metaJson};\n` +
    `const gz = Uint8Array.from(atob(document.getElementById('gzdata').textContent), c => c.charCodeAt(0)).buffer;\n` +
    `const binBuf = await new Response(new Response(gz).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();`
  );
app = `(async function () {\n${app}\n})();`;

// HTML shell from index.html
const idx = r('index.html');
const style = idx.match(/<style>[\s\S]*?<\/style>/)[0];
const body = idx.match(/<body>([\s\S]*?)\s*<script type="module"/)[1].trim();

const gzScript = `<script id="gzdata" type="application/octet-stream+base64">${gzB64}</script>`;
const module = `<script type="module">\n${three}\n${threeNs}\n${orbit}\n${app}\n</script>`;
const artifact = `${style}\n${body}\n${gzScript}\n${module}\n`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/middle-east-terrain.html'), artifact);
console.log(`wrote dist/middle-east-terrain.html (${(artifact.length / 1024 / 1024).toFixed(2)} MB)`);

const full = `<!doctype html><html><head><meta charset="utf-8"><title>Middle East Terrain</title></head><body>${artifact}</body></html>`;
fs.writeFileSync(path.join(ROOT, 'dist/_test_full.html'), full);
