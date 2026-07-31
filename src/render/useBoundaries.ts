import { useEffect, useRef, useState } from "react";
import type { ViewportShapes } from "../data/cells";
import { useApp } from "../store";

/** Polygons above this count in view are dropped in favour of centroid dots. */
export const MAX_VISIBLE_POLYGONS = 40000;

const QUERY_DEBOUNCE_MS = 120;

/** Shared "nothing to draw" value, so identity checks stay cheap. */
const EMPTY: BoundaryResult = { tooMany: false, loading: false };

export interface BoundaryResult {
  shapes?: Extract<ViewportShapes, { tooMany: false }>;
  /** True when the viewport holds more polygons than we will draw. */
  tooMany: boolean;
  loading: boolean;
  error?: string;
}

/**
 * Keeps the visible slice of one boundary set in sync with the viewport.
 *
 * The full geometry (600k polygons, ~120 MB) stays in the worker; only the
 * polygons intersecting the current view cross to the main thread, as transfer-
 * able binary buffers deck.gl can upload directly.
 */
export function useBoundaries(
  name: string,
  enabled: boolean,
  bounds: readonly [number, number, number, number] | undefined,
): BoundaryResult {
  const client = useApp((s) => s.cellsClient);
  const dataset = useApp((s) => s.dataset);
  const [result, setResult] = useState<BoundaryResult>(EMPTY);
  const loaded = useRef<Promise<unknown> | undefined>(undefined);
  const loadedFor = useRef<unknown>(undefined);
  const requestId = useRef(0);

  useEffect(() => {
    // A new worker invalidates the geometry the old one had decoded.
    if (loadedFor.current !== client) {
      loadedFor.current = client;
      loaded.current = undefined;
    }
    if (!enabled || !client || !dataset || !bounds) {
      // Invalidate anything in flight; the stale result is simply not returned
      // (see below) rather than cleared, which would be a redundant render.
      requestId.current++;
      return;
    }
    const id = ++requestId.current;

    const timer = setTimeout(() => {
      void (async () => {
        // Flagged only once the debounce actually fires, so a viewport that is
        // still moving does not flicker the panel between states.
        setResult((prev) => ({ ...prev, loading: true, error: undefined }));
        try {
          // The parquet decode happens once; later viewport changes are cheap.
          if (!loaded.current) {
            loaded.current = client.loadBoundaries(dataset, name).then((summary) => {
              console.info(
                `[cells] ${name}: ${summary.count.toLocaleString("en-US")} polygons, ` +
                  `${summary.vertices.toLocaleString("en-US")} vertices in ${summary.elapsedMs} ms`,
              );
              return summary;
            });
          }
          await loaded.current;
          const shapes = await client.viewportShapes(
            name,
            [bounds[0], bounds[1], bounds[2], bounds[3]],
            MAX_VISIBLE_POLYGONS,
          );
          if (requestId.current !== id) return;
          setResult(
            shapes.tooMany
              ? { tooMany: true, loading: false }
              : { shapes, tooMany: false, loading: false },
          );
        } catch (err) {
          console.error(`boundaries "${name}" failed`, err);
          if (requestId.current !== id) return;
          loaded.current = undefined;
          setResult({
            tooMany: false,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }, QUERY_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [client, dataset, name, enabled, bounds]);

  return enabled && client && dataset && bounds ? result : EMPTY;
}
