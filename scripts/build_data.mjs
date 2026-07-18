#!/usr/bin/env node
// Build a baked elevation + per-country mask grid for the Middle East region.
//
// Data sources (fetched at build time, not shipped):
//   - Elevation: AWS "terrarium" DEM tiles (public, no key)
//       https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png
//       encoded as height = R*256 + G + B/256 - 32768  (metres)
//   - Borders: per-country MultiPolygons (mledoze/countries, ODbL)
//
// Output: data/region_elevation.bin.gz  + data/region_elevation.json
//   .bin (gzipped) = Int16 elevations (row-major) then Uint8 country id per cell
//   country id 0 = sea / outside region; 1..N index into meta.countries.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// Middle East + Iran + Turkey. Order = country id order (1..N).
const COUNTRIES = [
  ['tur', 'Türkiye'], ['irn', 'Iran'], ['irq', 'Iraq'], ['syr', 'Syria'],
  ['lbn', 'Lebanon'], ['isr', 'Israel'], ['pse', 'Palestine'], ['jor', 'Jordan'],
  ['sau', 'Saudi Arabia'], ['yem', 'Yemen'], ['omn', 'Oman'], ['are', 'United Arab Emirates'],
  ['qat', 'Qatar'], ['bhr', 'Bahrain'], ['kwt', 'Kuwait'], ['egy', 'Egypt'], ['cyp', 'Cyprus'],
];

const ZOOM = 6;                 // terrarium zoom (~500 m/px here — ample for ~5 km cells)
const TARGET_COLS = 820;        // full-res grid columns
const TILE_BASE = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';
const GEO_BASE = 'https://raw.githubusercontent.com/mledoze/countries/master/data';

// ---- Web Mercator helpers --------------------------------------------------
const TILE = 256;
const worldSize = z => TILE * 2 ** z;
const lon2px = (lon, z) => (lon + 180) / 360 * worldSize(z);
const lat2px = (lat, z) => {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize(z);
};

async function get(url, kind = 'buf', attempt = 0) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return kind === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (attempt >= 4) throw new Error(`${url}: ${e.message}`);
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
    return get(url, kind, attempt + 1);
  }
}

// ---- point-in-polygon (MultiPolygon with holes) ----------------------------
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pointInPolys(lon, lat, polys) {
  for (const poly of polys) {
    if (!pointInRing(lon, lat, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (pointInRing(lon, lat, poly[h])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

async function main() {
  // --- fetch borders ---
  console.log(`fetching ${COUNTRIES.length} country borders…`);
  const geo = [];
  for (const [code, name] of COUNTRIES) {
    const g = await get(`${GEO_BASE}/${code}.geo.json`, 'json');
    const gm = g.features[0].geometry;
    const polys = gm.type === 'Polygon' ? [gm.coordinates] : gm.coordinates;
    // per-country lon/lat bbox for fast cell pre-filtering
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const poly of polys) for (const [x, y] of poly[0]) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    geo.push({ code, name, polys, bbox: [x0, y0, x1, y1] });
  }

  // --- region bbox (union) + grid ---
  let lonMin = 1e9, lonMax = -1e9, latMin = 1e9, latMax = -1e9;
  for (const c of geo) {
    lonMin = Math.min(lonMin, c.bbox[0]); latMin = Math.min(latMin, c.bbox[1]);
    lonMax = Math.max(lonMax, c.bbox[2]); latMax = Math.max(latMax, c.bbox[3]);
  }
  const pad = 0.1;
  lonMin -= pad; lonMax += pad; latMin -= pad; latMax += pad;

  const meanLat = (latMin + latMax) / 2;
  const cosLat = Math.cos(meanLat * Math.PI / 180);
  const cellLonDeg = (lonMax - lonMin) / TARGET_COLS;
  const cellKm = cellLonDeg * 111.32 * cosLat;
  const cellLatDeg = cellKm / 111.32;
  const rows = Math.round((latMax - latMin) / cellLatDeg);
  const cols = TARGET_COLS;
  console.log(`region lon ${lonMin.toFixed(1)}..${lonMax.toFixed(1)} lat ${latMin.toFixed(1)}..${latMax.toFixed(1)}`);
  console.log(`grid ${cols} x ${rows}  (~${cellKm.toFixed(2)} km cells)`);

  // --- tiles ---
  const tx0 = Math.floor(lon2px(lonMin, ZOOM) / TILE), tx1 = Math.floor(lon2px(lonMax, ZOOM) / TILE);
  const ty0 = Math.floor(lat2px(latMax, ZOOM) / TILE), ty1 = Math.floor(lat2px(latMin, ZOOM) / TILE);
  const nX = tx1 - tx0 + 1, nY = ty1 - ty0 + 1;
  console.log(`tiles z${ZOOM}: x ${tx0}..${tx1} y ${ty0}..${ty1} (${nX * nY} tiles)`);

  const mosaicW = nX * TILE, mosaicH = nY * TILE;
  const src = new Float32Array(mosaicW * mosaicH);
  let done = 0;
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const png = PNG.sync.read(await get(`${TILE_BASE}/${ZOOM}/${tx}/${ty}.png`));
    const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
    for (let py = 0; py < TILE; py++) for (let px = 0; px < TILE; px++) {
      const si = (py * TILE + px) * 4;
      src[(oy + py) * mosaicW + (ox + px)] =
        png.data[si] * 256 + png.data[si + 1] + png.data[si + 2] / 256 - 32768;
    }
    if (++done % 8 === 0 || done === nX * nY) process.stdout.write(`\r  tiles ${done}/${nX * nY}`);
  }
  process.stdout.write('\n');

  const bpx0 = tx0 * TILE, bpy0 = ty0 * TILE;
  const sampleElev = (lon, lat) => {
    const gx = lon2px(lon, ZOOM) - bpx0, gy = lat2px(lat, ZOOM) - bpy0;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, mosaicW - 1), y1 = Math.min(y0 + 1, mosaicH - 1);
    const fx = gx - x0, fy = gy - y0;
    const a = src[y0 * mosaicW + x0], b = src[y0 * mosaicW + x1];
    const c = src[y1 * mosaicW + x0], d = src[y1 * mosaicW + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };

  // helpers to map lon/lat <-> grid col/row
  const lon2col = lon => Math.floor((lon - lonMin) / (lonMax - lonMin) * cols);
  const lat2row = lat => Math.floor((latMax - lat) / (latMax - latMin) * rows);

  // --- country id mask (rasterise each country within its bbox) ---
  const cid = new Uint8Array(cols * rows);
  const cellBox = geo.map(() => [1e9, 1e9, -1e9, -1e9]); // [cmin,rmin,cmax,rmax]
  for (let gi = 0; gi < geo.length; gi++) {
    const c = geo[gi];
    const c0 = Math.max(0, lon2col(c.bbox[0]) - 1), c1 = Math.min(cols - 1, lon2col(c.bbox[2]) + 1);
    const r0 = Math.max(0, lat2row(c.bbox[3]) - 1), r1 = Math.min(rows - 1, lat2row(c.bbox[1]) + 1);
    for (let r = r0; r <= r1; r++) {
      const lat = latMax - (r + 0.5) * (latMax - latMin) / rows;
      for (let cc = c0; cc <= c1; cc++) {
        const idx = r * cols + cc;
        if (cid[idx]) continue;
        const lon = lonMin + (cc + 0.5) * (lonMax - lonMin) / cols;
        if (pointInPolys(lon, lat, c.polys)) {
          cid[idx] = gi + 1;
          const b = cellBox[gi];
          if (cc < b[0]) b[0] = cc; if (r < b[1]) b[1] = r;
          if (cc > b[2]) b[2] = cc; if (r > b[3]) b[3] = r;
        }
      }
    }
    process.stdout.write(`\r  mask ${gi + 1}/${geo.length} (${c.code})`);
  }
  process.stdout.write('\n');

  // --- elevation on land cells ---
  const elev = new Int16Array(cols * rows);
  let land = 0, eMin = 1e9, eMax = -1e9;
  for (let r = 0; r < rows; r++) {
    const lat = latMax - (r + 0.5) * (latMax - latMin) / rows;
    for (let cc = 0; cc < cols; cc++) {
      const idx = r * cols + cc;
      if (!cid[idx]) continue;
      const lon = lonMin + (cc + 0.5) * (lonMax - lonMin) / cols;
      const h = sampleElev(lon, lat);
      elev[idx] = Math.round(h);
      land++; if (h < eMin) eMin = h; if (h > eMax) eMax = h;
    }
    if (r % 64 === 0) process.stdout.write(`\r  elev ${r}/${rows}`);
  }
  process.stdout.write(`\r  elev ${rows}/${rows}\n`);
  console.log(`land cells ${land}  elev ${eMin.toFixed(0)}..${eMax.toFixed(0)} m`);

  // --- write gzipped binary ---
  const bin = Buffer.alloc(elev.length * 2 + cid.length);
  Buffer.from(elev.buffer).copy(bin, 0);
  Buffer.from(cid.buffer).copy(bin, elev.length * 2);
  const gz = zlib.gzipSync(bin, { level: 9 });
  fs.writeFileSync(path.join(DATA, 'region_elevation.bin.gz'), gz);

  const meta = {
    region: 'Middle East',
    source: { elevation: `AWS terrarium DEM tiles (SRTM/ASTER), zoom ${ZOOM}`, border: 'mledoze/countries (ODbL)' },
    cols, rows, lonMin, lonMax, latMin, latMax, meanLat, cosLat,
    cellKm: +cellKm.toFixed(3), elevMin: Math.round(eMin), elevMax: Math.round(eMax),
    layout: { elev: 'int16', cid: 'uint8', order: 'row-major, row0=north', gzip: true },
    countries: geo.map((c, i) => ({
      id: i + 1, code: c.code, name: c.name,
      cell: cellBox[i][0] <= cellBox[i][2] ? cellBox[i] : null, // [cmin,rmin,cmax,rmax]
    })),
  };
  fs.writeFileSync(path.join(DATA, 'region_elevation.json'), JSON.stringify(meta, null, 2));
  console.log(`wrote data/region_elevation.bin.gz (${(gz.length / 1024).toFixed(0)} KB) + .json`);
}

main().catch(e => { console.error(e); process.exit(1); });
