/**
 * Minimal WKB reader for the polygon geometries in SpatialData's GeoParquet
 * shapes.
 *
 * Only the exterior ring is kept: Xenium cell and nucleus boundaries are simple
 * closed rings (25 points for cells), never holed. MultiPolygon is accepted but
 * reduced to its first part, which is what a renderer would show anyway.
 */

const WKB_POLYGON = 3;
const WKB_MULTIPOLYGON = 6;

interface RingHeader {
  /** Byte offset of the first coordinate. */
  offset: number;
  count: number;
  littleEndian: boolean;
}

function readRingHeader(view: DataView): RingHeader | undefined {
  const littleEndian = view.getUint8(0) === 1;
  let offset = 1;
  const type = view.getUint32(offset, littleEndian);
  offset += 4;

  if (type === WKB_MULTIPOLYGON) {
    const parts = view.getUint32(offset, littleEndian);
    offset += 4;
    if (parts === 0) return undefined;
    // Each part is a full WKB geometry; step into the first one's header.
    offset += 1 + 4;
  } else if (type !== WKB_POLYGON) {
    return undefined;
  }

  const rings = view.getUint32(offset, littleEndian);
  offset += 4;
  if (rings === 0) return undefined;
  const count = view.getUint32(offset, littleEndian);
  offset += 4;
  return { offset, count, littleEndian };
}

/** Number of exterior-ring vertices, without decoding coordinates. */
export function wkbVertexCount(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return readRingHeader(view)?.count ?? 0;
}

/**
 * Writes the exterior ring into `out` starting at `outIndex` (in vertices),
 * applying `x * sx + tx` / `y * sy + ty`. Returns the vertex count written.
 */
export function wkbReadRing(
  bytes: Uint8Array,
  out: Float32Array,
  outIndex: number,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readRingHeader(view);
  if (!header) return 0;
  const { offset, count, littleEndian } = header;
  let write = outIndex * 2;
  for (let i = 0; i < count; i++) {
    const base = offset + i * 16;
    out[write++] = view.getFloat64(base, littleEndian) * sx + tx;
    out[write++] = view.getFloat64(base + 8, littleEndian) * sy + ty;
  }
  return count;
}
