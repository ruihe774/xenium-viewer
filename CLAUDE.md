# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A browser-based alternative to 10x Xenium Explorer. It reads **SpatialData zarr** stores
(zarr v3) entirely client-side — no server, no upload, no Python at runtime. Only Xenium is
supported. See `README.md` for the user-facing description.

`.venv/` holds Python `spatialdata` and is used **only** for inspecting sample data from the
shell. The app never touches it.

## Commands

```bash
npm run dev           # vite dev server on :5173 (strict port)
npm run check         # typecheck + lint + format check; run this before calling anything done
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm run format        # prettier --write .
npm run format:check  # prettier --check .
npm run build         # tsc -b && vite build
npm run preview       # serve the production build on :4173
```

There is no test suite. `npm run check` plus driving the app in a browser is the whole
verification story — see "Verifying changes".

### Formatting

Prettier, config in `.prettierrc.json`. Defaults are kept except `printWidth: 100` and
`trailingComma: "all"`, matching the width and comma style the codebase already used before
Prettier existed. `eslint-config-prettier` is the last entry in `eslint.config.js` so stylistic
ESLint rules never fight Prettier's output.

### Linting

ESLint 9 flat config in `eslint.config.js`, with **type-aware** `typescript-eslint` rules —
most of the value here is in catching floating promises and `any` leaking across the worker
boundary, none of which is visible without types. Both must stay clean.

`reportUnusedDisableDirectives` is set to **error**: an `eslint-disable` that no longer
suppresses anything fails the lint. So when you silence a rule, silence exactly the rules that
fire and no more, and delete the directive when the underlying code changes.

Two consequences worth knowing before you write new code:

- **Interface members use property syntax** (`open: (spec) => void`), not method syntax
  (`open(spec): void`). Method syntax makes `unbound-method` fire wherever a caller pulls the
  function off the object — which is exactly how zustand actions and the Comlink worker APIs
  are consumed. Property syntax is also stricter about parameter variance.
- **Worker methods need not be `async`.** Comlink surfaces every one as a promise to callers
  regardless, so marking a method `async` with nothing to await just trips `require-await`.

The existing disables are all deliberate and commented: Viv's untyped extra layer props, the
bare string Viv requires for aborted tiles, the debug `window.__deck` handle, a stable array
index key, and two effects that legitimately set state (a worker pool's handle, and an initial
view that depends on a post-layout measurement).

## Local data

Not in git (`.gitignore`), but present in the working tree:

- `slide01.zarr/` — Xenium 5K TMA, 16 GB. 51309×105305 px at 0.2125 µm/px, 4 morphology
  channels, 5 pyramid levels, 606,931 cells, 5,101 genes, 402.7M transcripts.
- `slide01_annotations/*.csv` — sample cell-group files (`cell_id,group,color`).
- `slide01_cellpose_cells.geojson` — sample alternative segmentation, 347 MB / 609,145 single-
  ring `Polygon` features, coordinates in micrometres. Feature ids are a different vocabulary
  from the table's cell ids (see the GeoJSON import constraints below).

The dev server exposes the repo root at `/data` with byte-range support (see the
`serveData` plugin in `vite.config.ts`), so all three are reachable over HTTP:

```
http://localhost:5173/?zarr=/data/slide01.zarr&x=25000&y=52000&zoom=-1
```

`zarr` is the store URL; `x`, `y` (level-0 image pixels) and `zoom` pin the view, which makes
screenshots reproducible. Omit them to fit the whole slide.

## Architecture

```
src/
  data/      store backends, dataset model, recents + settings, worker clients
  workers/   image tiles, cell table + geometry, expression, transcripts,
             AnnData helpers, WKB, GeoJSON, spatial grid, CSV
  render/    Viv pixel source, deck.gl layers, the viewer component
  ui/        panels, gene list, colormaps, minimap, scale bar
  store.ts   zustand; single source of truth for all display state
```

Two workers do the heavy lifting, and both keep their bulk data worker-side:

- **`workers/image.worker.ts`** — a pool of three, each holding an LRU of _decoded_ chunks.
  Chunks are 4096² uint16 (33.5 MB) and zstd-compressed, so decoding dominates. Requests are
  routed to a worker by chunk coordinate (`ImagePyramid.#route`) so a chunk is decoded and
  held exactly once. Tiles are cut from the cache and transferred back zero-copy.
- **`workers/cells.worker.ts`** — the cell table, boundary geometry (~120 MB of flat
  `Float32Array`), and imported group assignments. Only the polygons intersecting the current
  viewport cross to the main thread, chosen via a uniform grid over bounding boxes.
- **`workers/expression.worker.ts`** — `X` in a compact resident CSR (~445 MB), read lazily
  the first time a gene is picked. Only the requested gene's dense column crosses back.
- **`workers/transcripts.worker.ts`** — a row-group index over the 69 transcript parquet
  parts, plus an LRU of decoded row groups (256 MB). Only the points in view cross back.

**Everything renders in level-0 image pixels.** Shapes, centroids and transcripts are stored
in micrometres; the scale factor in the shapes element's `coordinateTransformations` converts
them, and its reciprocal is `dataset.pixelSizeUm`. Never hardcode 0.2125.

## Constraints that will bite you

These were each found the hard way. Changing the code around them will silently break things.

**Vite reserves `?url`** as an import query, so the app's parameter is `?zarr=`. Using `?url=`
makes Vite reject the request with a 403 before the app ever loads.

**hyparquet needs `utf8: false` and `geoparquet: false`.** Its default text-decodes plain
`BYTE_ARRAY` columns, which corrupts every WKB byte ≥ 0x80; and its GeoJSON conversion is far
slower than reading the rings into typed arrays. Columns with a STRING logical type still
decode to strings.

**deck.gl's tile cache defaults to 5× the visible tile count**, which reached ~2 GB on a
whole-slide view. `maxCacheSize` is capped explicitly in `Viewer.tsx`.

**Gene ids ascend within each CSR row**, which is the whole reason `geneValues` can binary-
search a gene's column out of a row-major matrix in ~17 ms. No CSC transpose exists and none
should be added — it would cost a second copy of a 154M-element index for nothing. The
property is verified once after loading (`#checkSorted`) and falls back to a linear scan if a
store ever violates it.

**`X/data` holds small integers**, max 1495 on the sample slide with 0.007% above 255, which
is what makes the `Uint8Array` + overflow-map storage safe. The worker samples three slices
before committing to it and falls back to `Float32Array` for anything non-integer — a
normalised or log-transformed matrix would otherwise be silently truncated.

**`points.feature_name` and `var/_index` are different vocabularies** — 9,716 categories
against 5,101 genes, the surplus being control probes and deprecated codewords. Points are
coded by name lookup into `var`, with `UNKNOWN_FEATURE` for the rest. Never index one by the
other positionally.

**The transcripts worker must not start before the gene list is read.** Its feature→gene
coding is baked into the row groups it caches, so an empty list would silently mark every
transcript unknown. `initTranscripts` awaits `genesPending` for exactly this reason.

**Transcript row groups all carry x/y statistics**, and the viewport gate is an area-weighted
estimate over them. That is what keeps a zoomed-out view free: the decision to draw nothing is
made from the footers, without decoding any parquet. Dropping the projection (`x`, `y`,
`feature_name` only) or the row-group index makes a pan read gigabytes.

**Multi-part parquet needs a directory listing, and HTTP has none.** `FileSystemStore`
enumerates properly; the fetch backend probes `part.N.parquet` in batches until the first gap,
which works because dask names parts contiguously from zero.

**Viv's `selections` array identity must be stable.** Viv refetches every raster and drops its
tile cache whenever it changes, so it is memoized on channel _count_, not on the channel
objects. Rebuilding it per contrast tweak makes every slider drag re-read the pyramid.

**Our `PixelSource` deliberately has no `getRaster`.** Viv feature-detects it to add a
full-level backdrop layer (~42 MB per channel); the minimap covers that need instead. Adding
`getRaster` back silently reintroduces the memory cost.

**Create and destroy workers in the same effect.** `ImagePyramid` is built inside a
`useEffect`, not a `useMemo`, because React StrictMode remounts: a memo survives the remount
while the first cleanup already terminated its workers, leaving a live object whose every call
hangs forever. `store.open()` guards against StrictMode's double-invoke the same way.

**zarrita 0.7 is required** for the zarr v3 `"string"` dtype (cell ids). Viv bundles its own
zarrita 0.5 — that is fine because no zarr object is ever handed to Viv, only our own
`PixelSource`. Do not try to unify them.

**deck.gl and luma.gl are pinned to exact 9.3.3** with `overrides`, matching Viv 0.22's peer
range. Duplicate luma.gl instances render a silently blank canvas.

**Per-cell colours are RGBA (`size: 4`), and alpha carries visibility.** Hiding a cell group
sets alpha to 0 rather than rebuilding geometry, which keeps picking indices stable. If you
change the stride, update `buildColors` in `store.ts` _and_ `expandColors` in
`boundaryLayers.ts` _and_ the layer attribute sizes together.

**`cell_boundaries` is written in table row order; `nucleus_boundaries` is not** (609,656 rows
against 606,931 cells — a cell can have more than one nucleus). `matchToTable` fast-paths the
aligned case and falls back to an id lookup otherwise. Do not assume index equality.

**Consolidated metadata is required.** The whole node tree is discovered from the root
`zarr.json`; the store interface has no `list`, so without it there is no way to enumerate
children. `loadDataset` throws `UnsupportedDatasetError` with an actionable message.

**Worker `console` output does not reach the page console**, so anything you want to read back
during debugging must be returned to the main thread and logged there (see how boundary load
timings are reported through `BoundarySummary.elapsedMs`).

**Imported GeoJSON is parsed per-feature, never with one `JSON.parse` on the whole file.** A
347 MB / 609k-feature FeatureCollection produces an object graph in the low gigabytes if parsed
whole. `workers/geojson.ts` streams the file (`Blob.stream()`), tracks brace depth with string/
escape awareness to find each top-level feature object inside `"features"`, and calls
`JSON.parse` on just that slice — 2.9 s for the sample file, against ~2.0 s for a hand-rolled
byte scanner that was benchmarked and rejected because it cannot handle escapes or nested
structure by construction. Reset the scanner's depth/string/escape state after every chunk
boundary; skipping that silently stops parsing after the first chunk.

**An imported segmentation keeps only the exterior ring**, exactly like `wkb.ts` does for
GeoParquet: `exteriorRing()` in `geojson.ts` takes a `Polygon`'s first ring or a `MultiPolygon`'s
first part, because the flat `starts`/`coords` layout has one vertex range per polygon and
cannot express holes or multiple parts. Dropped rings are counted and surfaced in the panel, not
silently discarded.

**The imported segmentation lives under the fixed key `IMPORTED_SEGMENTATION_KEY`** in the cells
worker's `#boundaries` map (`workers/geojson.ts`, imported by both the worker and
`data/cells.ts` — not from `cells.worker.ts` itself, since that module's top-level
`Comlink.expose(...)` would otherwise get bundled into the main thread). There is only one slot;
re-importing replaces it. Its `cellIndices` are left at `-1` throughout — the feature ids are a
different vocabulary from the cell table's and are never read — which is also why it never
answers picking (see the RGBA/alpha note above: `expandColors` already paints unmatched polygons
with the caller's fallback colour).

## Verifying changes

Use the in-app Browser tools against the dev server. Load a pinned view so screenshots are
comparable:

```
http://localhost:5173/?zarr=/data/slide01.zarr&x=25000&y=52000&zoom=-1
```

Useful checks, all from `javascript_tool`:

```js
// Heap. Main thread only — worker heaps are separate and not reportable.
performance.memory.usedJSHeapSize / 1048576;

// Layers, tile cache occupancy, selected pyramid level (dev builds only).
window.__deck.layerManager.getLayers().map((l) => l.id);
```

**The console reader does not clear on navigation**, so stale errors from earlier HMR updates
persist and look current. Check timestamps in the stack traces, or reload and compare, before
chasing an error. HMR in particular produces transient "Invalid hook call" and mid-edit render
failures that do not reproduce on a fresh load.

**File import can be driven without a real file dialog** by dispatching a drop event, which
exercises the actual handler:

```js
const blob = await (await fetch("/data/slide01_annotations/slide01_major_cell_type.csv")).blob();
const dt = new DataTransfer();
dt.items.add(new File([blob], "slide01_major_cell_type.csv", { type: "text/csv" }));
document
  .querySelector(".dropzone")
  .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
```

Two panels use `.dropzone` now — cell groups and the alternative-segmentation import. The bare
`document.querySelector(".dropzone")` above still resolves to the cell-groups one (it is mounted
first); target `.dropzone.segmentation` for the GeoJSON import, e.g. with
`slide01_cellpose_cells.geojson` (see "Local data").

**`showDirectoryPicker` cannot be driven from the browser tools** — it needs a real user
gesture on a native dialog. Ask the user to test that path when it is touched.

Reference timings on the sample slide, for spotting regressions: centroids ~250 ms, channel
stats ~1.0 s, cell boundaries ~1.4 s (606,931 polygons / 15.2M vertices), expression matrix
~4.3 s (154,647,224 non-zeros, 445 MB resident), gene switch 15–18 ms, transcript row-group
index ~2.8 s (69 parts / 417 row groups), one transcript row group ~180 ms, GeoJSON segmentation
import ~2–3 s (609,145 polygons / 14.2M vertices, ~130 MB resident in the cells worker). Heap
~210 MB at whole-slide view and ~570 MB at native resolution — the expression matrix and the
transcript cache are in worker heaps and do not show up there; an imported segmentation is the
same, so importing one should not move this number.

## Conventions

- TypeScript strict, including `noUnusedLocals` / `noUnusedParameters`. `npm run check` is the
  only automated gate; keep it clean.
- Comments explain _why_, especially where the code works around a library's behaviour. The
  constraints above are all documented at their call sites too — keep those in sync.
- Tuning constants (cache sizes, tile size, polygon caps, zoom thresholds) are named
  module-level constants with a comment giving the reasoning, not inline magic numbers.
- Display state lives in `store.ts` and is persisted per dataset via `data/recents.ts`.
  Persist user choices only — never derived data such as histograms, thumbnails or colour
  buffers.

## Deliberately out of scope

Writing anything back to the store, and any coordinate transform beyond scale/translation
(`readXYTransform` throws on affine and rotation rather than misplacing data).
