import type { DataSource } from "./stores";
import { readJson } from "./stores";

// ---------------------------------------------------------------------------
// Raw zarr v3 consolidated metadata
// ---------------------------------------------------------------------------

interface NodeMeta {
  node_type: "array" | "group";
  attributes?: Record<string, unknown>;
  shape?: number[];
  data_type?: string;
  chunk_grid?: { configuration?: { chunk_shape?: number[] } };
}

interface RootMeta {
  attributes?: {
    spatialdata_attrs?: { version?: string };
    spatialdata_io_reader?: string;
  };
  consolidated_metadata?: { metadata: Record<string, NodeMeta> };
}

/** Every node in the store, keyed by path relative to the root ("" is the root). */
export type NodeIndex = Map<string, NodeMeta>;

// ---------------------------------------------------------------------------
// Coordinate transforms
// ---------------------------------------------------------------------------

/** A 2D scale + translation mapping element coordinates into pixel space. */
export interface XYTransform {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

export const IDENTITY_XY: XYTransform = { sx: 1, sy: 1, tx: 0, ty: 0 };

interface RawTransform {
  type: string;
  scale?: number[];
  translation?: number[];
  transformations?: RawTransform[];
  output?: { name?: string };
}

/**
 * Reduces a SpatialData `coordinateTransformations` entry to the x/y scale and
 * translation that map an element into the target coordinate system.
 *
 * SpatialData writes one transform per target system; Xenium output only ever
 * uses identity/scale/translation (optionally nested in a sequence), so affine
 * and rotation are deliberately not handled — they throw rather than silently
 * misplacing data.
 */
export function readXYTransform(
  transforms: unknown,
  axes: string[],
  target = "global",
): XYTransform {
  if (!Array.isArray(transforms) || transforms.length === 0) return IDENTITY_XY;
  const list = transforms as RawTransform[];
  const chosen = list.find((t) => t.output?.name === target) ?? list[0];
  const xi = axes.indexOf("x");
  const yi = axes.indexOf("y");
  if (xi < 0 || yi < 0) return IDENTITY_XY;

  const out = { ...IDENTITY_XY };
  const apply = (t: RawTransform): void => {
    switch (t.type) {
      case "identity":
        return;
      case "scale": {
        const s = t.scale ?? [];
        out.sx *= s[xi] ?? 1;
        out.sy *= s[yi] ?? 1;
        out.tx *= s[xi] ?? 1;
        out.ty *= s[yi] ?? 1;
        return;
      }
      case "translation": {
        const d = t.translation ?? [];
        out.tx += d[xi] ?? 0;
        out.ty += d[yi] ?? 0;
        return;
      }
      case "sequence":
        for (const child of t.transformations ?? []) apply(child);
        return;
      default:
        throw new Error(`Unsupported coordinate transformation "${t.type}"`);
    }
  };
  apply(chosen);
  return out;
}

// ---------------------------------------------------------------------------
// Dataset model
// ---------------------------------------------------------------------------

export interface ImageLevel {
  /** Store path, e.g. `images/morphology_focus/s0`. */
  path: string;
  /** Full array shape in axis order (`c,y,x` for images, `y,x` for labels). */
  shape: number[];
  chunkShape: number[];
  width: number;
  height: number;
  /** Downsample factor relative to level 0. */
  downsample: number;
}

export interface ImageElement {
  name: string;
  path: string;
  axes: string[];
  dtype: string;
  levels: ImageLevel[];
  channels: { label: string }[];
  width: number;
  height: number;
}

export interface ShapeElement {
  name: string;
  path: string;
  /** Directory or file holding the geometry, relative to the store root. */
  parquetPath: string;
  toPixel: XYTransform;
}

/**
 * Code for a point whose feature is not a row of the table's `var`.
 *
 * The sample slide's transcripts carry 9,716 distinct feature names against
 * 5,101 genes in the table — the surplus is control probes, deprecated
 * codewords and unpanelled entries. They are kept and drawn in a neutral
 * colour rather than dropped, but they can never be indexed into the gene
 * list, so the two must never be indexed by one another.
 *
 * Lives here rather than in the transcripts worker because both sides of that
 * boundary need it, and importing a value from a `?worker` module would run
 * the worker on the main thread.
 */
export const UNKNOWN_FEATURE = 0xffff;

export interface PointsElement {
  name: string;
  path: string;
  /** Directory (or single file) holding the points, relative to the store root. */
  parquetPath: string;
  toPixel: XYTransform;
  /** Column naming what each point is, e.g. `feature_name`. */
  featureKey: string;
  /** Column linking a point back to a row of the table, e.g. `cell_id`. */
  instanceKey?: string;
}

export type ObsColumn =
  | { name: string; kind: "numeric"; path: string; dtype: string }
  | { name: string; kind: "categorical"; path: string }
  | { name: string; kind: "string"; path: string };

/**
 * The expression matrix, when it is CSR over cells — the only layout we read.
 * Dense and CSC `X` are left undefined rather than throwing, so the rest of the
 * dataset still opens and only the gene features go missing.
 */
export interface XMatrix {
  path: string;
  /** Non-zeros, from the length of `X/data`. */
  nnz: number;
  nObs: number;
  nVar: number;
}

export interface TableElement {
  path: string;
  nObs: number;
  /** Column holding cell ids (AnnData `_index`). */
  indexColumn: ObsColumn;
  columns: ObsColumn[];
  /** Path to `obsm/spatial` if present. */
  spatialPath?: string;
  /** Path to `var/_index` (gene names). */
  varIndexPath?: string;
  nVar?: number;
  x?: XMatrix;
}

export interface Dataset {
  name: string;
  nodes: NodeIndex;
  images: ImageElement[];
  labels: ImageElement[];
  shapes: ShapeElement[];
  points: PointsElement[];
  table?: TableElement;
  /** Physical size of one level-0 image pixel, in micrometres. */
  pixelSizeUm: number;
  /** Level-0 pixel extent of the primary image. */
  width: number;
  height: number;
  reader?: string;
}

function attr<T>(node: NodeMeta | undefined, key: string): T | undefined {
  return node?.attributes?.[key] as T | undefined;
}

function childNames(nodes: NodeIndex, prefix: string): string[] {
  const out = new Set<string>();
  const head = `${prefix}/`;
  for (const key of nodes.keys()) {
    if (!key.startsWith(head)) continue;
    const rest = key.slice(head.length);
    if (!rest.includes("/")) out.add(rest);
  }
  return [...out];
}

interface OmeAttrs {
  multiscales?: {
    datasets: { path: string; coordinateTransformations?: RawTransform[] }[];
    axes: { name: string; type: string }[];
  }[];
  omero?: { channels?: { label?: string }[] };
}

function readMultiscale(nodes: NodeIndex, path: string, name: string): ImageElement | undefined {
  const node = nodes.get(path);
  const ome = attr<OmeAttrs>(node, "ome");
  const multiscale = ome?.multiscales?.[0];
  if (!multiscale) return undefined;

  const axes = multiscale.axes.map((a) => a.name);
  const xi = axes.indexOf("x");
  const yi = axes.indexOf("y");

  const levels: ImageLevel[] = [];
  for (const dataset of multiscale.datasets) {
    const levelPath = `${path}/${dataset.path}`;
    const arr = nodes.get(levelPath);
    if (!arr?.shape) continue;
    const scale = dataset.coordinateTransformations?.find((t) => t.type === "scale")?.scale;
    levels.push({
      path: levelPath,
      shape: arr.shape,
      chunkShape: arr.chunk_grid?.configuration?.chunk_shape ?? arr.shape,
      width: arr.shape[xi],
      height: arr.shape[yi],
      downsample: scale?.[xi] ?? 1,
    });
  }
  if (levels.length === 0) return undefined;

  const ci = axes.indexOf("c");
  const nChannels = ci >= 0 ? levels[0].shape[ci] : 1;
  const labels = ome?.omero?.channels ?? [];
  const channels = Array.from({ length: nChannels }, (_, i) => ({
    label: labels[i]?.label ?? `Channel ${i + 1}`,
  }));

  return {
    name,
    path,
    axes,
    dtype: nodes.get(levels[0].path)?.data_type ?? "uint16",
    levels,
    channels,
    width: levels[0].width,
    height: levels[0].height,
  };
}

function readObsColumn(nodes: NodeIndex, path: string, name: string): ObsColumn | undefined {
  const node = nodes.get(path);
  if (!node) return undefined;
  const encoding = attr<string>(node, "encoding-type");
  if (encoding === "categorical") return { name, kind: "categorical", path };
  if (encoding === "nullable-string-array" || encoding === "string-array") {
    return { name, kind: "string", path };
  }
  if (node.node_type === "array") {
    const dtype = node.data_type ?? "";
    if (dtype === "string") return { name, kind: "string", path };
    if (dtype === "bool") return { name, kind: "categorical", path };
    return { name, kind: "numeric", path, dtype };
  }
  return undefined;
}

function readTable(nodes: NodeIndex, path: string): TableElement | undefined {
  const obsPath = `${path}/obs`;
  const obs = nodes.get(obsPath);
  if (!obs) return undefined;

  const indexName = attr<string>(obs, "_index") ?? "_index";
  const indexColumn = readObsColumn(nodes, `${obsPath}/${indexName}`, indexName);
  if (!indexColumn) return undefined;

  const order = attr<string[]>(obs, "column-order") ?? childNames(nodes, obsPath);
  const columns: ObsColumn[] = [];
  for (const name of order) {
    if (name === indexName) continue;
    const column = readObsColumn(nodes, `${obsPath}/${name}`, name);
    if (column) columns.push(column);
  }

  // Row count comes from whichever obs array we can see first.
  const sample = nodes.get(`${obsPath}/${order[0]}`) ?? nodes.get(`${obsPath}/${indexName}/values`);
  const nObs = sample?.shape?.[0] ?? nodes.get(`${path}/obsm/spatial`)?.shape?.[0] ?? 0;

  const varIndexName = attr<string>(nodes.get(`${path}/var`), "_index") ?? "_index";
  const varIndexPath = nodes.has(`${path}/var/${varIndexName}/values`)
    ? `${path}/var/${varIndexName}/values`
    : nodes.has(`${path}/var/${varIndexName}`)
      ? `${path}/var/${varIndexName}`
      : undefined;

  const nVar = nodes.get(`${path}/var/${varIndexName}/values`)?.shape?.[0];

  return {
    path,
    nObs,
    indexColumn,
    columns,
    spatialPath: nodes.has(`${path}/obsm/spatial`) ? `${path}/obsm/spatial` : undefined,
    varIndexPath,
    nVar,
    x: readXMatrix(nodes, `${path}/X`, nObs, nVar),
  };
}

/**
 * Describes `X` when it is a CSR matrix over cells.
 *
 * AnnData records the logical shape on the group and stores `data`, `indices`
 * and `indptr` beside it. Anything else — dense arrays, CSC — returns undefined
 * so the caller can hide the gene features rather than fail to open the store.
 */
function readXMatrix(
  nodes: NodeIndex,
  path: string,
  nObs: number,
  nVar: number | undefined,
): XMatrix | undefined {
  const node = nodes.get(path);
  if (!node || attr<string>(node, "encoding-type") !== "csr_matrix") return undefined;
  const shape = attr<number[]>(node, "shape");
  const nnz = nodes.get(`${path}/data`)?.shape?.[0];
  if (!shape || nnz === undefined) return undefined;
  if (!nodes.has(`${path}/indices`) || !nodes.has(`${path}/indptr`)) return undefined;
  // The group's own shape wins; obs/var are only a cross-check for stores that
  // omit it.
  return { path, nnz, nObs: shape[0] ?? nObs, nVar: shape[1] ?? nVar ?? 0 };
}

/** Thrown for stores we can read but deliberately do not support. */
export class UnsupportedDatasetError extends Error {}

export async function loadDataset(source: DataSource): Promise<Dataset> {
  const root = await readJson<RootMeta>(source, "/zarr.json");
  if (!root) {
    throw new UnsupportedDatasetError(
      "No zarr.json at the root — this does not look like a SpatialData zarr store.",
    );
  }
  const consolidated = root.consolidated_metadata?.metadata;
  if (!consolidated) {
    throw new UnsupportedDatasetError(
      "The store has no consolidated metadata. Re-write it with spatialdata >= 0.2 " +
        "(`sdata.write(path, consolidate_metadata=True)`).",
    );
  }

  const nodes: NodeIndex = new Map(Object.entries(consolidated));
  nodes.set("", { node_type: "group", attributes: root.attributes });

  const images: ImageElement[] = [];
  for (const name of childNames(nodes, "images")) {
    const element = readMultiscale(nodes, `images/${name}`, name);
    if (element) images.push(element);
  }
  const labels: ImageElement[] = [];
  for (const name of childNames(nodes, "labels")) {
    const element = readMultiscale(nodes, `labels/${name}`, name);
    if (element) labels.push(element);
  }

  const shapes: ShapeElement[] = [];
  for (const name of childNames(nodes, "shapes")) {
    const path = `shapes/${name}`;
    const node = nodes.get(path);
    if (!node) continue;
    shapes.push({
      name,
      path,
      parquetPath: `${path}/shapes.parquet`,
      toPixel: readXYTransform(
        attr(node, "coordinateTransformations"),
        attr<string[]>(node, "axes") ?? ["x", "y"],
      ),
    });
  }

  const points: PointsElement[] = [];
  for (const name of childNames(nodes, "points")) {
    const path = `points/${name}`;
    const node = nodes.get(path);
    if (!node) continue;
    const attrs = attr<{ feature_key?: string; instance_key?: string }>(node, "spatialdata_attrs");
    points.push({
      name,
      path,
      parquetPath: `${path}/points.parquet`,
      // Points carry three axes; readXYTransform indexes the scale by the
      // position of x/y within the element's own axes, so z is ignored.
      toPixel: readXYTransform(
        attr(node, "coordinateTransformations"),
        attr<string[]>(node, "axes") ?? ["x", "y"],
      ),
      featureKey: attrs?.feature_key ?? "feature_name",
      instanceKey: attrs?.instance_key,
    });
  }

  const tableName = childNames(nodes, "tables")[0];
  const table = tableName ? readTable(nodes, `tables/${tableName}`) : undefined;

  if (images.length === 0) {
    throw new UnsupportedDatasetError("No multiscale images found under `images/`.");
  }

  // Shapes and points are stored in micrometres and scaled into pixel space,
  // so the transform's scale factor is pixels-per-micrometre.
  const pxPerUm = shapes[0]?.toPixel.sx ?? 0;
  const pixelSizeUm = pxPerUm > 0 ? 1 / pxPerUm : 1;

  const primary = images.find((i) => i.name === "morphology_focus") ?? images[0];

  return {
    name: source.spec.name,
    nodes,
    images,
    labels,
    shapes,
    points,
    table,
    pixelSizeUm,
    width: primary.width,
    height: primary.height,
    reader: root.attributes?.spatialdata_io_reader,
  };
}
