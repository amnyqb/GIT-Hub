# Saudi Arabia — 3D Terrain Block Diagram

A three.js-powered, interactive 3D block diagram of the **Kingdom of Saudi Arabia's
surface elevation**, clipped to the national border. Inspired by Evan Applegate's
US forest-canopy block diagram — but since Saudi Arabia is overwhelmingly desert
with negligible tree canopy, the meaningful analogue here is **terrain elevation**.

Each column is a cell of a digital elevation model. You can see the **Asir & Hijaz
highlands** rising along the Red Sea (peaks ~2,900 m near Abha), the **Najd plateau**
around Riyadh, and the flat vastness of the **Rub al Khali** (Empty Quarter) sloping
down to the Persian Gulf.

![preview](docs/preview.png)

## Features

- **Resolution tabs** — 1/8, quarter, half, and full resolution (up to ~151k columns).
- **Orthographic / perspective** projection toggle.
- **Sliders** — vertical exaggeration, colour saturation, sun azimuth / elevation /
  intensity, ambient light, and shadow softness.
- **Real-time drop shadows** and a hypsometric colour ramp (teal lowlands → sand →
  orange highlands → pale peaks).
- **Export transparent 4K PNG** of the current view.
- Live camera HUD (position / target / zoom).

## Run

No build step or server framework needed — it's static files plus vendored three.js.

```bash
npm install        # only needed to (re)build the data; three is vendored in src/vendor
npm run serve      # serves the app at http://localhost:8099
```

Then open <http://localhost:8099/>. (Any static file server works; a server is
required because the app fetches the data files as ES-module resources.)

## Data

The elevation grid is pre-baked into `data/saudi_elevation.bin` (Int16 elevations +
a Uint8 land mask, row-major) with metadata in `data/saudi_elevation.json`.

To regenerate it from source:

```bash
npm install
npm run build-data
```

`scripts/build_data.mjs` downloads public **AWS Terrain ("terrarium") DEM tiles**
(NASA SRTM/ASTER, no API key) covering the country's bounding box, decodes the
elevation-encoded PNGs, resamples them onto a ~3.6 km grid, and rasterises the
Saudi Arabia border polygon (from
[mledoze/countries](https://github.com/mledoze/countries), ODbL) into a land mask.

## Layout

```
index.html                    UI shell, styles, controls
src/app.js                    three.js scene, instanced blocks, controls wiring
src/vendor/                   vendored three.js + OrbitControls (no CDN needed)
data/                         baked elevation grid + border GeoJSON
scripts/build_data.mjs        reproducible data pipeline
scripts/serve.mjs             tiny static dev server
```

## Credits

- Elevation: AWS Terrain Tiles (SRTM / ASTER), via the terrarium encoding.
- Border: mledoze/countries (ODbL).
- Concept inspired by Evan Applegate's GEDI canopy-height block diagram of the US.
