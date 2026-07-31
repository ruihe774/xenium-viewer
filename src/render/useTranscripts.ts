import { useEffect, useRef, useState } from "react";
import type { ViewportPoints } from "../data/transcripts";
import { useApp } from "../store";

/**
 * Points above this count in view are not drawn at all.
 *
 * 402.7M transcripts cannot be rendered, and there is no zoom threshold that
 * means the same thing on every slide — a dense tumour core holds far more per
 * micrometre than fatty tissue. Gating on the point count the row-group
 * statistics predict adapts to both, and costs nothing: the estimate comes from
 * the footers, so an over-full viewport decodes no parquet at all.
 */
export const MAX_VISIBLE_TRANSCRIPTS = 1_500_000;

const QUERY_DEBOUNCE_MS = 120;

/** Shared "nothing to draw" value, so identity checks stay cheap. */
const EMPTY: TranscriptResult = { tooMany: false, loading: false, count: 0, total: 0 };

export interface TranscriptResult {
  points?: Extract<ViewportPoints, { tooMany: false }>;
  /** True when the viewport holds more points than we will draw. */
  tooMany: boolean;
  loading: boolean;
  /** Points in view — the estimate when `tooMany`, the exact count otherwise. */
  total: number;
  count: number;
  error?: string;
}

/**
 * Keeps the visible slice of the transcripts in sync with the viewport.
 *
 * Mirrors `useBoundaries`: debounce, a one-shot init memoized against the
 * client identity, and a monotonic request id so a slow response for an old
 * viewport is dropped rather than drawn.
 */
export function useTranscripts(
  enabled: boolean,
  bounds: readonly [number, number, number, number] | undefined,
): TranscriptResult {
  const client = useApp((s) => s.transcriptsClient);
  const initTranscripts = useApp((s) => s.initTranscripts);
  const [result, setResult] = useState<TranscriptResult>(EMPTY);
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled || !client || !bounds) {
      requestId.current++;
      return;
    }
    const id = ++requestId.current;

    const timer = setTimeout(() => {
      void (async () => {
        setResult((prev) => ({ ...prev, loading: true, error: undefined }));
        try {
          // Reading 69 parquet footers happens once; it is shared through the
          // store so a remount does not repeat it.
          await initTranscripts();
          const points = await client.viewport(
            [bounds[0], bounds[1], bounds[2], bounds[3]],
            MAX_VISIBLE_TRANSCRIPTS,
          );
          if (requestId.current !== id) return;
          setResult(
            points.tooMany
              ? { tooMany: true, loading: false, count: 0, total: points.estimate }
              : {
                  points,
                  tooMany: false,
                  loading: false,
                  count: points.count,
                  total: points.total,
                },
          );
        } catch (err) {
          console.error("transcripts failed", err);
          if (requestId.current !== id) return;
          setResult({
            tooMany: false,
            loading: false,
            count: 0,
            total: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }, QUERY_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [client, initTranscripts, enabled, bounds]);

  return enabled && client && bounds ? result : EMPTY;
}
