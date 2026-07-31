import { useEffect, useState } from "react";
import { deleteRecent, listRecents, type RecentRecord } from "../data/recents";
import { useApp } from "../store";

const supportsPicker = typeof window !== "undefined" && "showDirectoryPicker" in window;

/** Under a week: relative ("3 days ago"); older: an absolute date. */
function formatWhen(ms: number): string {
  const diffDays = Math.round((ms - Date.now()) / 86_400_000);
  if (Math.abs(diffDays) < 7) {
    return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(diffDays, "day");
  }
  return new Date(ms).toLocaleDateString();
}

export function OpenDialog() {
  const { status, error, open } = useApp();
  const [url, setUrl] = useState("/data/slide01.zarr");
  const [pickerError, setPickerError] = useState<string>();
  const [recents, setRecents] = useState<RecentRecord[]>();
  const [recentError, setRecentError] = useState<string>();

  // `?zarr=` auto-loads a store, which is how the app is driven in tests.
  // (`?url=` is reserved by Vite as a special import query, so it can't be used.)
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("zarr");
    if (!param) return;
    const name = param.split("/").filter(Boolean).pop() ?? param;
    void open({ kind: "http", url: param, name });
  }, [open]);

  useEffect(() => {
    void listRecents().then(setRecents);
  }, []);

  async function pickDirectory() {
    setPickerError(undefined);
    try {
      const handle = await window.showDirectoryPicker({ id: "xenium-zarr", mode: "read" });
      await open({ kind: "fs", handle, name: handle.name });
    } catch (err) {
      // The user dismissing the picker is not an error worth showing.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setPickerError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openRecent(record: RecentRecord) {
    setRecentError(undefined);
    if (record.kind === "http") {
      await open({ kind: "http", url: record.url ?? "", name: record.name });
      return;
    }
    if (!record.handle) return;
    // Must be the very first await in the handler: `requestPermission` needs
    // the click's transient user activation, and consumes it immediately.
    const permission = await record.handle.requestPermission({ mode: "read" });
    if (permission !== "granted") {
      setRecentError(`Permission for "${record.name}" was not granted. Pick the folder again.`);
      return;
    }
    await open({ kind: "fs", handle: record.handle, name: record.name });
  }

  async function removeRecent(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await deleteRecent(id);
    setRecents((prev) => prev?.filter((r) => r.id !== id));
  }

  const busy = status === "loading";

  // serveData implemented in vite.config.ts is not suitable for production environment,
  // where a static file server e.g. Nginx should be used. Disable it in prod.
  // In vite preview, this can still be tested by navigating to the URL with ?zarr.
  const showHttpPicker = import.meta.env.DEV;

  return (
    <div className="opener">
      <div className="opener-card">
        <h1>Xenium Viewer</h1>
        <p className="lede">Open a Xenium SpatialData zarr store.</p>

        <button
          className="primary"
          onClick={() => void pickDirectory()}
          disabled={!supportsPicker || busy}
        >
          {busy ? "Opening…" : "Open folder…"}
        </button>
        {!supportsPicker && (
          <p className="lede" style={{ marginTop: 8 }}>
            This browser has no File System Access API. Use Chrome, or load the store over HTTP
            below.
          </p>
        )}

        {showHttpPicker ? (
          <>
            <div className="divider">OR</div>

            <div className="row">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://host/slide.zarr"
                spellCheck={false}
              />
              <button
                onClick={() =>
                  void open({
                    kind: "http",
                    url,
                    name: url.split("/").filter(Boolean).pop() ?? url,
                  })
                }
                disabled={busy || url.trim() === ""}
              >
                Load
              </button>
            </div>
          </>
        ) : null}

        {recents && recents.length > 0 && (
          <>
            <div className="divider">RECENT</div>
            <ul className="recents">
              {recents.map((r) => (
                <li key={r.id} className="recent-row">
                  <button
                    className="recent-item"
                    onClick={() => void openRecent(r)}
                    disabled={busy}
                  >
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-meta">
                      {r.kind === "http" ? r.url : "Folder"} · {formatWhen(r.lastOpened)}
                    </span>
                  </button>
                  <button
                    className="recent-delete"
                    title="Remove from recent"
                    onClick={(e) => void removeRecent(r.id, e)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {(error ?? pickerError ?? recentError) && (
          <div className="error">{error ?? pickerError ?? recentError}</div>
        )}
      </div>
    </div>
  );
}
