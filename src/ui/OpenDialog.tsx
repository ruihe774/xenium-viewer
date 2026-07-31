import { useEffect, useState } from "react";
import { useApp } from "../store";

const supportsPicker = typeof window !== "undefined" && "showDirectoryPicker" in window;

export function OpenDialog() {
  const { status, error, open } = useApp();
  const [url, setUrl] = useState("/data/slide01.zarr");
  const [pickerError, setPickerError] = useState<string>();

  // `?zarr=` auto-loads a store, which is how the app is driven in tests.
  // (`?url=` is reserved by Vite as a special import query, so it can't be used.)
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("zarr");
    if (!param) return;
    const name = param.split("/").filter(Boolean).pop() ?? param;
    void open({ kind: "http", url: param, name });
  }, [open]);

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

        {showHttpPicker ? <>
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
                void open({ kind: "http", url, name: url.split("/").filter(Boolean).pop() ?? url })
              }
              disabled={busy || url.trim() === ""}
            >
              Load
            </button>
          </div>
        </> : null}

        {(error ?? pickerError) && <div className="error">{error ?? pickerError}</div>}
      </div>
    </div>
  );
}
