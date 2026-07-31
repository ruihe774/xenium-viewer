import * as Comlink from "comlink";
import type {
  TranscriptsInit,
  TranscriptsWorkerApi,
  ViewportPoints,
} from "../workers/transcripts.worker";
import TranscriptsWorker from "../workers/transcripts.worker?worker";
import type { PointsElement } from "./dataset";
import type { SourceSpec } from "./stores";

export type { TranscriptsInit, ViewportPoints };

/** Main-thread handle to the transcripts worker. */
export class TranscriptsClient {
  #worker = new TranscriptsWorker();
  #api: Comlink.Remote<TranscriptsWorkerApi>;

  constructor() {
    this.#api = Comlink.wrap<TranscriptsWorkerApi>(this.#worker);
  }

  /**
   * `genes` is the table's `var` index. Points are coded against it in the
   * worker so that only a 16-bit code per point crosses back, rather than the
   * feature name of every transcript in view.
   */
  init(spec: SourceSpec, element: PointsElement, genes: string[]): Promise<TranscriptsInit> {
    return this.#api.init(spec, element.parquetPath, element.toPixel, genes);
  }

  viewport(box: [number, number, number, number], maxPoints: number): Promise<ViewportPoints> {
    return this.#api.viewport(box, maxPoints);
  }

  destroy() {
    this.#worker.terminate();
  }
}
