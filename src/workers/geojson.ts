/**
 * Streaming reader for a GeoJSON `FeatureCollection`, used for user-imported
 * alternative segmentations.
 *
 * The sample file this was built against is 347 MB / 609k features — far too
 * large to `JSON.parse` whole (the resulting object graph runs into the low
 * gigabytes). Instead the stream is decoded incrementally and only the text of
 * one feature at a time is ever parsed, by tracking brace depth (with string
 * and escape awareness) to find each top-level `{...}` inside the `"features"`
 * array. A hand-rolled number scanner was benchmarked at ~1.5x faster, but
 * real `JSON.parse` handles escapes, whitespace and nested structure for free
 * and the gap is small next to the rest of the app's load times (the
 * expression matrix alone takes ~4.3s) — see CLAUDE.md.
 */

/**
 * Key for the single imported alternative segmentation in the cells worker's
 * name-keyed boundary map. Namespaced with a colon so it can never collide
 * with a shapes element's name (those come from zarr group names, which
 * cannot contain one). Lives here rather than in cells.worker.ts so the main
 * thread can import it as a value without bundling that worker's top-level
 * `Comlink.expose(...)` side effect into the main chunk.
 */
export const IMPORTED_SEGMENTATION_KEY = "geojson:imported";

export interface GeoJsonFeature {
  type: string;
  id?: string | number;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

/**
 * Streams a FeatureCollection, calling `visit` once per top-level feature
 * object. `onProgress` is called with cumulative bytes read after each chunk.
 */
export async function forEachFeature(
  blob: Blob,
  visit: (feature: GeoJsonFeature) => void,
  onProgress?: (bytesRead: number) => void,
): Promise<void> {
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let started = false;
  let sawAnyFeature = false;
  let bytesRead = 0;

  // Brace-depth scanner state. Reset after every chunk boundary: `carry` is
  // always either empty or the (in-progress) start of a feature object, never
  // mid-string or mid-escape, so there is nothing to carry across a reset.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      const text = carry + decoder.decode(value, { stream: true });
      let consumed = 0;
      let i = 0;

      if (!started) {
        const key = text.indexOf('"features"');
        if (key < 0) {
          // Still haven't seen the key; keep buffering. A file that never
          // contains it will fail with the error below once the stream ends.
          carry = text;
          onProgress?.(bytesRead);
          continue;
        }
        const bracket = text.indexOf("[", key);
        if (bracket < 0) {
          carry = text;
          onProgress?.(bytesRead);
          continue;
        }
        i = bracket + 1;
        consumed = i;
        started = true;
      }

      for (; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (inString) {
          if (escaped) escaped = false;
          else if (c === 92 /* \ */) escaped = true;
          else if (c === 34 /* " */) inString = false;
          continue;
        }
        if (c === 34 /* " */) {
          inString = true;
          continue;
        }
        if (c === 123 /* { */) {
          if (depth === 0) objectStart = i;
          depth++;
          continue;
        }
        if (c === 125 /* } */) {
          depth--;
          if (depth === 0) {
            const feature = JSON.parse(text.slice(objectStart, i + 1)) as GeoJsonFeature;
            sawAnyFeature = true;
            visit(feature);
            consumed = i + 1;
          }
        }
      }

      carry = text.slice(consumed);
      depth = 0;
      inString = false;
      escaped = false;
      objectStart = -1;
      onProgress?.(bytesRead);
    }
  } finally {
    reader.releaseLock();
  }

  if (!started) {
    throw new Error('No "features" array found — expected a GeoJSON FeatureCollection.');
  }
  if (!sawAnyFeature) {
    throw new Error("No features found in the GeoJSON file.");
  }
}

/**
 * The exterior ring of a Polygon, or of a MultiPolygon's first part — the
 * same reduction `wkb.ts` makes and for the same reason: the flat layout
 * downstream has one vertex range per polygon and cannot express holes or
 * multiple parts.
 */
export function exteriorRing(geometry: GeoJsonFeature["geometry"]): number[][] | undefined {
  if (!geometry) return undefined;
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates as number[][][];
    return rings[0];
  }
  if (geometry.type === "MultiPolygon") {
    const parts = geometry.coordinates as number[][][][];
    return parts[0]?.[0];
  }
  return undefined;
}
