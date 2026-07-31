# Xenium Viewer

A browser-based alternative to 10x Xenium Explorer.
It reads [SpatialData](https://spatialdata.scverse.org/en/stable/) zarr stores.
Everything runs client-side in Chrome — there is no server component and no upload;
the data is read directly off disk (or over HTTP) in chunks.
Try it: https://xenium-viewer.ruihe774.workers.dev/.

## What it does

- **Multichannel morphology image** — full pyramid, 16-bit, additive blending, per-channel
  colour / visibility / contrast with an intensity histogram and automatic initial windowing.
- **Cell layer** — all 600k+ cells, drawn as boundary polygons when zoomed in and as centroid
  dots when zoomed out, with nucleus boundaries as an optional overlay.
- **Colour by any `obs` column** — numeric columns get a colormap with a percentile-based
  range you can adjust; categorical columns get a palette and legend.
- **Cell groups** — import your own per-cell annotations from CSV, colour by them, and show
  or hide individual groups. Use the same CSV format as in Xenium Explorer.
- **Inspection** — hover for a readout, click a cell to pin its full `obs` record.
- **Navigation** — whole-slide minimap with click-to-jump, µm scale bar, and linkable views.

## Prepare SpatialData zarr files

Just use your saved zarr files if you're already using SpatialData, or:

```python
import spatialdata_io
sdata = spatialdata_io.xenium("/path/to/your/slide/")
sdata.write("slide01.zarr")
```

Then open the zarr in Xenium Viewer.

## Running it

```bash
npm install && npm run dev
```

Then open <http://localhost:5173> and either click **Open folder…** to pick a `.zarr` directory,
or paste an HTTP URL. See `CLAUDE.md` for dev server details and how to link to saved views.

## Cell groups

Drop one or more CSVs onto the **Cell groups** panel (or use the button). Each file is one
annotation of the same cells — cell type, lineage, cluster, whatever you have:

```csv
cell_id,group,color
aaaacgpa-1,B,#cb81da
aaaagjhh-1,T,#0fd50b
aaaahaac-1,Plasma,
```

- `cell_id` must match the table's index. Rows for cells not in the dataset are counted and
  reported; if _nothing_ matches, the import fails rather than adding an empty set.
- `color` is optional — as a column, and per row. A group's colour is taken from the first row
  that supplies one, so declaring it once is enough; groups with no colour fall back to the
  built-in categorical palette. `#rgb`, `#rrggbb`, and `r,g,b` are accepted.
- The header is optional too. Without one, columns are read positionally.

Load several files and switch between them from **Colour by**; each keeps its own
show/hide state, and every membership shows up in the cell inspector.

## Requirements

- **Chrome** (or another Chromium browser). The folder picker uses the File System Access API;
  the HTTP path works anywhere, but Chrome is what this is tested against.
- A SpatialData zarr store written by `spatialdata-io`'s Xenium reader, **with consolidated
  metadata** (`sdata.write(path)` in spatialdata ≥ 0.2 does this). The whole node tree is
  discovered from the root `zarr.json`; without it there is no way to list children.
- Zarr v3 is required; zarrita handles the v3 codec set.
