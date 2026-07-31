# Xenium Viewer

A browser-based alternative to 10x Xenium Explorer that reads **SpatialData zarr** stores
instead of Xenium's native output bundle. Everything runs client-side in Chrome — there is no
server component and no upload; the data is read directly off disk (or over HTTP) in chunks.

## What it does

- **Multichannel morphology image** — full pyramid, 16-bit, additive blending, per-channel
  colour / visibility / contrast with an intensity histogram and automatic initial windowing.
- **Cell layer** — all 600k+ cells, drawn as boundary polygons when zoomed in and as centroid
  dots when zoomed out, with nucleus boundaries as an optional overlay.
- **Colour by any `obs` column** — numeric columns get a colormap with a percentile-based
  range you can adjust; categorical columns get a palette and legend.
- **Inspection** — hover for a readout, click a cell to pin its full `obs` record.
- **Navigation** — whole-slide minimap with click-to-jump, µm scale bar, and linkable views.

Display settings are remembered per dataset in `localStorage`.

## Running it

```bash
npm install && npm run dev
```

Then open <http://localhost:5173> and either click **Open folder…** to pick a `.zarr` directory,
or paste an HTTP URL.

The dev server also exposes the repo directory at `/data` with byte-range support, so a store
sitting next to the source can be opened directly — and linked to:

```
http://localhost:5173/?zarr=/data/slide01.zarr&x=25000&y=52000&zoom=-1
```

`zarr` is the store URL; `x`, `y` (level-0 image pixels) and `zoom` pin the view. Omit them to
fit the whole slide. Set `XENIUM_DATA_ROOT` to expose a different directory. `npm run preview`
serves the production build with the same `/data` route.

> The query parameter is `?zarr=`, not `?url=` — Vite reserves `?url` as a special import query.

## Requirements

- **Chrome** (or another Chromium browser). The folder picker uses the File System Access API;
  the HTTP path works anywhere, but Chrome is what this is tested against.
- A SpatialData zarr store written by `spatialdata-io`'s Xenium reader, **with consolidated
  metadata** (`sdata.write(path)` in spatialdata ≥ 0.2 does this). The whole node tree is
  discovered from the root `zarr.json`; without it there is no way to list children.
- Zarr v3 with `zstd` / `sharding_indexed` / `crc32c` / `vlen-utf8` codecs is what the reference
  dataset uses and what is exercised; zarrita handles the rest of the v3 codec set too.

## How it works

```
src/
  data/      store backends (directory handle / HTTP), dataset model, settings
  workers/   image tile decoding, cell table + boundary geometry, WKB, spatial grid
  render/    Viv pixel source, deck.gl layers, the viewer component
  ui/        panels, colormaps, minimap, scale bar
```

Three things carry most of the weight:

**Image tiles.** Chunks are 4096×4096 uint16 (33.5 MB decoded) and zstd-compressed, so decoding
dominates. A pool of three workers decodes them and caches the *decoded* chunks; tiles are cut
from that cache and transferred back as zero-copy buffers. Requests are routed to a worker by
chunk coordinate, so a chunk is only ever decoded and held once. Rendering uses Viv's
`MultiscaleImageLayer` with a hand-rolled `PixelSource` — Viv's own zarr loader rejects
SpatialData's `0.5-dev-spatialdata` multiscales version and pins an older zarrita.

**Cell geometry.** `shapes.parquet` is one 103 MB row group of WKB polygons. hyparquet reads it
with `geoparquet: false` and `utf8: false` (its default would text-decode the WKB and corrupt
every byte ≥ 0x80), and the rings go straight into flat `Float32Array`s — 606,931 polygons and
15.2M vertices in about 1.4 s. That geometry stays in the worker; only the polygons intersecting
the viewport cross to the main thread, selected via a uniform grid over bounding boxes. Above
40,000 polygons in view the layer falls back to centroid dots.

**Coordinates.** Everything renders in level-0 image pixels. Shapes and centroids are stored in
micrometres, so the scale factor from the shapes element's `coordinateTransformations` is what
converts them — and its reciprocal is the pixel size (0.2125 µm for the reference slide) that
drives the scale bar.

## Not included

Transcript rendering and per-cell gene expression are deliberately out of scope for this build.
Expression would need a different access pattern: `X` is CSR over cells, so pulling one gene's
column means scanning all 154M non-zeros. The layer plumbing is shaped to accept both later.
