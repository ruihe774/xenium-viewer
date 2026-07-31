import * as Comlink from "comlink";
import type { ColumnData } from "../workers/cells.worker";
import type {
  ExpressionInit,
  ExpressionWorkerApi,
  GeneCount,
  MatrixSummary,
} from "../workers/expression.worker";
import ExpressionWorker from "../workers/expression.worker?worker";
import type { Dataset } from "./dataset";
import type { SourceSpec } from "./stores";

export type { ExpressionInit, GeneCount, MatrixSummary };

/** Main-thread handle to the expression worker. */
export class ExpressionClient {
  #worker = new ExpressionWorker();
  #api: Comlink.Remote<ExpressionWorkerApi>;

  constructor() {
    this.#api = Comlink.wrap<ExpressionWorkerApi>(this.#worker);
  }

  init(spec: SourceSpec, dataset: Dataset): Promise<ExpressionInit> {
    if (!dataset.table?.x) throw new Error("Dataset has no CSR expression matrix");
    return this.#api.init(spec, dataset.table);
  }

  /**
   * Reads `X` into the worker. `onProgress` has to cross the worker boundary,
   * so it is passed as a Comlink proxy rather than a plain function.
   */
  loadMatrix(onProgress: (fraction: number) => void): Promise<MatrixSummary> {
    return this.#api.loadMatrix(Comlink.proxy(onProgress));
  }

  geneValues(gene: string): Promise<ColumnData> {
    return this.#api.geneValues(gene);
  }

  cellGenes(cell: number, topK: number): Promise<GeneCount[]> {
    return this.#api.cellGenes(cell, topK);
  }

  destroy() {
    this.#worker.terminate();
  }
}
