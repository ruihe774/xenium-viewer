/**
 * Uniform grid over polygon bounding boxes, for viewport queries.
 *
 * A grid rather than an R-tree because the data is a near-uniform sheet of
 * ~600k similarly-sized cells: bucket occupancy is even, build is a linear
 * counting sort, and lookups touch only the buckets a viewport covers.
 */
export class UniformGrid {
  #cellSize: number;
  #cols: number;
  #rows: number;
  #minX: number;
  #minY: number;
  /** Prefix offsets into `#items`, length cols*rows + 1. */
  #offsets: Uint32Array;
  #items: Uint32Array;

  constructor(bboxes: Float32Array, count: number, cellSize: number) {
    this.#cellSize = cellSize;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      if (bboxes[i * 4] < minX) minX = bboxes[i * 4];
      if (bboxes[i * 4 + 1] < minY) minY = bboxes[i * 4 + 1];
      if (bboxes[i * 4 + 2] > maxX) maxX = bboxes[i * 4 + 2];
      if (bboxes[i * 4 + 3] > maxY) maxY = bboxes[i * 4 + 3];
    }
    this.#minX = minX;
    this.#minY = minY;
    this.#cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    this.#rows = Math.max(1, Math.ceil((maxY - minY) / cellSize));

    // Bucket by bbox centre; queries widen by one cell to compensate.
    const buckets = this.#cols * this.#rows;
    const counts = new Uint32Array(buckets + 1);
    const bucketOf = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const cx = (bboxes[i * 4] + bboxes[i * 4 + 2]) / 2;
      const cy = (bboxes[i * 4 + 1] + bboxes[i * 4 + 3]) / 2;
      const col = Math.min(this.#cols - 1, Math.max(0, ((cx - minX) / cellSize) | 0));
      const row = Math.min(this.#rows - 1, Math.max(0, ((cy - minY) / cellSize) | 0));
      const bucket = row * this.#cols + col;
      bucketOf[i] = bucket;
      counts[bucket + 1]++;
    }
    for (let b = 0; b < buckets; b++) counts[b + 1] += counts[b];
    this.#offsets = counts;

    const cursor = counts.slice();
    const items = new Uint32Array(count);
    for (let i = 0; i < count; i++) items[cursor[bucketOf[i]]++] = i;
    this.#items = items;
  }

  /** Calls `visit` for every polygon whose bucket overlaps the box. */
  forEachInBox(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    visit: (index: number) => void,
  ): void {
    const size = this.#cellSize;
    // Widen by one cell: items are bucketed by centre, so a polygon just
    // outside the box may still overlap it.
    const colStart = Math.max(0, (((x0 - this.#minX) / size) | 0) - 1);
    const colEnd = Math.min(this.#cols - 1, ((x1 - this.#minX) / size) | 0);
    const rowStart = Math.max(0, (((y0 - this.#minY) / size) | 0) - 1);
    const rowEnd = Math.min(this.#rows - 1, ((y1 - this.#minY) / size) | 0);
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const bucket = row * this.#cols + col;
        const end = this.#offsets[bucket + 1];
        for (let k = this.#offsets[bucket]; k < end; k++) visit(this.#items[k]);
      }
    }
  }
}
