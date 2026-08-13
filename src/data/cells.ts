import * as Comlink from "comlink";
import type {
  BoundarySummary,
  CellsWorkerApi,
  ColumnData,
  GeoJsonSummary,
  GroupSetSummary,
  ViewportShapes,
} from "../workers/cells.worker";
import CellsWorker from "../workers/cells.worker?worker";
import { IMPORTED_SEGMENTATION_KEY } from "../workers/geojson";
import type { Dataset } from "./dataset";
import type { SourceSpec } from "./stores";

export type { BoundarySummary, ColumnData, GeoJsonSummary, GroupSetSummary, ViewportShapes };
export { IMPORTED_SEGMENTATION_KEY };

/** Main-thread handle to the cells worker. */
export class CellsClient {
  #worker = new CellsWorker();
  #api: Comlink.Remote<CellsWorkerApi>;

  constructor() {
    this.#api = Comlink.wrap<CellsWorkerApi>(this.#worker);
  }

  /**
   * Loads cell centroids. `obsm/spatial` is stored in micrometres, so the
   * transform of the matching shapes element is what maps it into pixel space —
   * the table itself carries no transform of its own.
   */
  async init(spec: SourceSpec, dataset: Dataset) {
    if (!dataset.table) throw new Error("Dataset has no table");
    return this.#api.init(spec, dataset.table, this.#alignmentTransform(dataset));
  }

  /**
   * The transform that maps micrometre coordinates into this dataset's
   * level-0 pixel space. `cell_boundaries` carries it in every SpatialData
   * Xenium store; falling back to the first shapes element covers stores that
   * name it differently. Shared by cell centroids and any imported geometry,
   * since both are µm coordinates that need to land in the same pixel space.
   */
  #alignmentTransform(dataset: Dataset) {
    const shapes = dataset.shapes.find((s) => s.name === "cell_boundaries") ?? dataset.shapes[0];
    if (!shapes) throw new Error("Dataset has no shapes element to align cells with");
    return shapes.toPixel;
  }

  ids(): Promise<string[]> {
    return this.#api.ids();
  }

  column(name: string): Promise<ColumnData> {
    return this.#api.column(name);
  }

  importGroups(name: string, text: string): Promise<GroupSetSummary> {
    return this.#api.importGroups(name, text);
  }

  removeGroups(name: string): Promise<void> {
    return this.#api.removeGroups(name);
  }

  loadBoundaries(dataset: Dataset, name: string): Promise<BoundarySummary> {
    const shapes = dataset.shapes.find((s) => s.name === name);
    if (!shapes) throw new Error(`No shapes element named "${name}"`);
    return this.#api.loadBoundaries(name, shapes.parquetPath, shapes.toPixel);
  }

  /**
   * Imports a GeoJSON FeatureCollection as the alternative segmentation.
   * `onProgress` has to cross the worker boundary, so it is passed as a
   * Comlink proxy rather than a plain function (mirrors `ExpressionClient`).
   */
  importGeoJson(
    dataset: Dataset,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<GeoJsonSummary> {
    return this.#api.importGeoJson(
      file,
      this.#alignmentTransform(dataset),
      Comlink.proxy(onProgress),
    );
  }

  removeGeoJson(): Promise<void> {
    return this.#api.removeGeoJson();
  }

  viewportShapes(
    name: string,
    box: [number, number, number, number],
    maxCells: number,
  ): Promise<ViewportShapes> {
    return this.#api.viewportShapes(name, box, maxCells);
  }

  details(index: number): Promise<Record<string, string>> {
    return this.#api.details(index);
  }

  destroy() {
    this.#worker.terminate();
  }
}
