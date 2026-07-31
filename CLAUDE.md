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

The dev server exposes the repo root at `/data` with byte-range support (see the
`serveData` plugin in `vite.config.ts`), so both are reachable over HTTP:

```
http://localhost:5173/?zarr=/data/slide01.zarr&x=25000&y=52000&zoom=-1
```

`zarr` is the store URL; `x`, `y` (level-0 image pixels) and `zoom` pin the view, which makes
screenshots reproducible. Omit them to fit the whole slide.

## Architecture

```
src/
  data/      store backends, dataset model, settings, cells worker client
  workers/   image tiles, cell table + geometry, WKB, spatial grid, CSV
  render/    Viv pixel source, deck.gl layers, the viewer component
  ui/        panels, colormaps, minimap, scale bar
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

**`showDirectoryPicker` cannot be driven from the browser tools** — it needs a real user
gesture on a native dialog. Ask the user to test that path when it is touched.

Reference timings on the sample slide, for spotting regressions: centroids ~250 ms, channel
stats ~1.0 s, cell boundaries ~1.4 s (606,931 polygons / 15.2M vertices), heap ~210 MB at
whole-slide view and ~570 MB at native resolution.

## Conventions

- TypeScript strict, including `noUnusedLocals` / `noUnusedParameters`. `npm run check` is the
  only automated gate; keep it clean.
- Comments explain _why_, especially where the code works around a library's behaviour. The
  constraints above are all documented at their call sites too — keep those in sync.
- Tuning constants (cache sizes, tile size, polygon caps, zoom thresholds) are named
  module-level constants with a comment giving the reasoning, not inline magic numbers.
- Display state lives in `store.ts` and is persisted per dataset via `data/settings.ts`.
  Persist user choices only — never derived data such as histograms, thumbnails or colour
  buffers.

## Deliberately out of scope

Transcript rendering (402.7M points) and per-cell gene expression. `X` is CSR over cells, so
reading one gene's column means scanning all 154M non-zeros — it needs a different access
pattern than anything here. The layer and colouring plumbing is shaped to accept both later.
