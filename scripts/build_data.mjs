#!/usr/bin/env node
// Build a baked elevation + country-mask grid for Saudi Arabia.
//
// Data sources (fetched at build time, not shipped):
//   - Elevation: AWS "terrarium" DEM tiles (public, no key)
//       https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png
//       encoded as height = R*256 + G + B/256 - 32768  (metres)
//   - Border: Saudi Arabia MultiPolygon (mledoze/countries, ODbL)
//
// Output: data/saudi_elevation.bin  + data/saudi_elevation.json (metadata)
// The .bin holds Int16 elevations (row-major) followed by a 1-byte-per-cell mask.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const ZOOM = 7;                 // terrarium zoom level (~300 m/px at this latitude)
const TARGET_COLS = 600;        // full-res grid columns
const TILE_BASE = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';

// ---- geo helpers (Web Mercator) --------------------------------------------
const TILE = 256;
const worldSize = z => TILE * 2 ** z;
const lon2px = (lon, z) => (lon + 180) / 360 * worldSize(z);
const lat2px = (lat, z) => {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize(z);
};

async function fetchTile(z, x, y, attempt = 0) {
  const url = `${TILE_BASE}/${z}/${x}/${y}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (attempt >= 4) throw new Error(`tile ${z}/${x}/${y}: ${e.message}`);
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
    return fetchTile(z, x, y, attempt + 1);
  }
}

// ---- point-in-polygon (MultiPolygon with holes) ----------------------------
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInMultiPolygon(lon, lat, polys) {
  for (const poly of polys) {
    if (!pointInRing(lon, lat, poly[0])) continue;      // outside outer ring
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lon, lat, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

async function main() {
  // --- load border, compute bbox ---
  const geo = JSON.parse(fs.readFileSync(path.join(DATA, 'saudi_arabia.geo.json'), 'utf8'));
  const gm = geo.features[0].geometry;
  const polys = gm.type === 'Polygon' ? [gm.coordinates] : gm.coordinates;

  let lonMin = 1e9, lonMax = -1e9, latMin = 1e9, latMax = -1e9;
  for (const poly of polys) for (const [x, y] of poly[0]) {
    lonMin = Math.min(lonMin, x); lonMax = Math.max(lonMax, x);
    latMin = Math.min(latMin, y); latMax = Math.max(latMax, y);
  }
  // small padding so coastal cells aren't clipped
  const pad = 0.05;
  lonMin -= pad; lonMax += pad; latMin -= pad; latMax += pad;

  const meanLat = (latMin + latMax) / 2;
  const cosLat = Math.cos(meanLat * Math.PI / 180);
  // square metric cells: choose rows from the aspect ratio
  const cellLonDeg = (lonMax - lonMin) / TARGET_COLS;
  const cellKm = cellLonDeg * 111.32 * cosLat;
  const cellLatDeg = cellKm / 111.32;
  const rows = Math.round((latMax - latMin) / cellLatDeg);
  const cols = TARGET_COLS;
  console.log(`grid ${cols} x ${rows}  (~${cellKm.toFixed(2)} km cells)`);

  // --- tile range ---
  const tx0 = Math.floor(lon2px(lonMin, ZOOM) / TILE);
  const tx1 = Math.floor(lon2px(lonMax, ZOOM) / TILE);
  const ty0 = Math.floor(lat2px(latMax, ZOOM) / TILE);   // north = smaller y
  const ty1 = Math.floor(lat2px(latMin, ZOOM) / TILE);
  const nX = tx1 - tx0 + 1, nY = ty1 - ty0 + 1;
  console.log(`tiles z${ZOOM}: x ${tx0}..${tx1} y ${ty0}..${ty1} (${nX * nY} tiles)`);

  // --- download + assemble mosaic ---
  const mosaicW = nX * TILE, mosaicH = nY * TILE;
  const elev = new Float32Array(mosaicW * mosaicH);
  let done = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const buf = await fetchTile(ZOOM, tx, ty);
      const png = PNG.sync.read(buf);
      const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
      for (let py = 0; py < TILE; py++) {
        for (let px = 0; px < TILE; px++) {
          const si = (py * TILE + px) * 4;
          const h = png.data[si] * 256 + png.data[si + 1] + png.data[si + 2] / 256 - 32768;
          elev[(oy + py) * mosaicW + (ox + px)] = h;
        }
      }
      done++;
      if (done % 8 === 0 || done === nX * nY) process.stdout.write(`\r  tiles ${done}/${nX * nY}`);
    }
  }
  process.stdout.write('\n');

  const px0 = tx0 * TILE, py0 = ty0 * TILE;
  const sampleElev = (lon, lat) => {
    const gx = lon2px(lon, ZOOM) - px0;
    const gy = lat2px(lat, ZOOM) - py0;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, mosaicW - 1), y1 = Math.min(y0 + 1, mosaicH - 1);
    const fx = gx - x0, fy = gy - y0;
    const a = elev[y0 * mosaicW + x0], b = elev[y0 * mosaicW + x1];
    const c = elev[y1 * mosaicW + x0], d = elev[y1 * mosaicW + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };

  // --- resample onto target grid + build mask ---
  const outElev = new Int16Array(cols * rows);
  const mask = new Uint8Array(cols * rows);
  let land = 0, hiMin = 1e9, hiMax = -1e9;
  for (let r = 0; r < rows; r++) {
    const lat = latMax - (r + 0.5) * (latMax - latMin) / rows;   // row 0 = north
    for (let c = 0; c < cols; c++) {
      const lon = lonMin + (c + 0.5) * (lonMax - lonMin) / cols;
      const idx = r * cols + c;
      const inside = pointInMultiPolygon(lon, lat, polys);
      mask[idx] = inside ? 1 : 0;
      let h = sampleElev(lon, lat);
      if (h < -100) h = 0;                    // clamp bathymetry / voids
      outElev[idx] = Math.round(h);
      if (inside) { land++; hiMin = Math.min(hiMin, h); hiMax = Math.max(hiMax, h); }
    }
    if (r % 64 === 0) process.stdout.write(`\r  resample ${r}/${rows}`);
  }
  process.stdout.write(`\r  resample ${rows}/${rows}\n`);
  console.log(`land cells ${land}  elev ${hiMin.toFixed(0)}..${hiMax.toFixed(0)} m`);

  // --- write binary: Int16 elev, then Uint8 mask ---
  const bin = Buffer.alloc(outElev.length * 2 + mask.length);
  Buffer.from(outElev.buffer).copy(bin, 0);
  Buffer.from(mask.buffer).copy(bin, outElev.length * 2);
  fs.writeFileSync(path.join(DATA, 'saudi_elevation.bin'), bin);

  const meta = {
    country: 'Saudi Arabia',
    source: {
      elevation: 'GEDI-style DEM via AWS terrarium tiles (NASA SRTM/ASTER), zoom ' + ZOOM,
      border: 'mledoze/countries (ODbL)'
    },
    cols, rows,
    lonMin, lonMax, latMin, latMax,
    meanLat, cosLat,
    cellKm: +cellKm.toFixed(3),
    elevMin: Math.round(hiMin), elevMax: Math.round(hiMax),
    layout: { elev: 'int16', mask: 'uint8', order: 'row-major, row0=north' }
  };
  fs.writeFileSync(path.join(DATA, 'saudi_elevation.json'), JSON.stringify(meta, null, 2));
  console.log(`wrote data/saudi_elevation.bin (${(bin.length / 1024).toFixed(0)} KB) + .json`);
}

main().catch(e => { console.error(e); process.exit(1); });
