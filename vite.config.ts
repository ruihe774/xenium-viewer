import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

/**
 * Serves a local directory over HTTP with byte-range support, so the app's
 * `http` store backend can be exercised without a separate server. Only active
 * in dev; production builds are static and read data via the directory picker
 * (or a URL the user supplies).
 *
 * Set `XENIUM_DATA_ROOT` to expose a different directory. Defaults to the repo
 * root, so `slide01.zarr` is reachable at `/data/slide01.zarr`.
 */
function serveData(): Plugin {
  const root = path.resolve(process.env.XENIUM_DATA_ROOT ?? process.cwd());

  type Middleware = (
    req: { url?: string; headers: Record<string, string | string[] | undefined> },
    res: import("node:http").ServerResponse,
    next: () => void,
  ) => void;

  const middleware: Middleware = (req, res, next) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.join(root, rel);
    // Refuse anything that escapes the exposed root.
    if (!file.startsWith(root + path.sep)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    stat(file).then(
      (info) => {
        if (!info.isFile()) {
          next();
          return;
        }
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "application/octet-stream");

        const range = req.headers.range;
        const match = /^bytes=(\d*)-(\d*)$/.exec(typeof range === "string" ? range : "");
        if (match) {
          const [, rawStart, rawEnd] = match;
          // `bytes=-N` means the last N bytes.
          const start = rawStart === "" ? info.size - Number(rawEnd) : Number(rawStart);
          const end = rawStart === "" || rawEnd === "" ? info.size - 1 : Number(rawEnd);
          if (start < 0 || start > end || end >= info.size) {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${info.size}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
          res.setHeader("Content-Length", String(end - start + 1));
          createReadStream(file, { start, end }).pipe(res);
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Length", String(info.size));
        createReadStream(file).pipe(res);
      },
      () => {
        res.statusCode = 404;
        res.end("Not found");
      },
    );
  };

  return {
    name: "xenium-serve-data",
    configureServer(server) {
      server.middlewares.use("/data", middleware);
    },
    // Also exposed under `vite preview`, so the production bundle can be
    // exercised against the same local store.
    configurePreviewServer(server) {
      server.middlewares.use("/data", middleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), serveData()],
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  build: { target: "es2022" },
});
