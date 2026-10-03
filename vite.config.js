import { createServer, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// The cold side proves withdrawals in a browser worker with the pinned Privacy Cash SDK; its circuit files are served
// from the SDK itself in dev and emitted unchanged into the build.
const require = createRequire(import.meta.url);
const sdkRoot = resolve(dirname(require.resolve("privacycash-evm")), "..");
const polyfills = () => nodePolyfills({ include: ["buffer", "crypto", "stream", "events", "util", "process"], globals: { Buffer: true, global: true, process: true } });

// The dev server answers /api/<name> with the same handlers Vercel runs, so local and production share one code path.
// Those handlers load through a second, plugin-free Vite instance: the browser polyfills must not replace node:crypto on the server.
let apiRunner = null;
const apiModules = (root) => (apiRunner ||= createServer({ configFile: false, root, logLevel: "error", appType: "custom", server: { middlewareMode: true, hmr: false } }));
export default defineConfig({
  optimizeDeps: { include: ["privacycash-evm"] },
  worker: { format: "es", plugins: () => [polyfills()] },
  plugins: [
    react(),
    polyfills(),
    {
      name: "local-api",
      generateBundle() {
        for (const ext of ["wasm", "zkey"]) this.emitFile({ type: "asset", fileName: `circuits/transaction2.${ext}`, source: readFileSync(resolve(sdkRoot, `circuits/transaction2.${ext}`)) });
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const path = new URL(req.url, "http://localhost").pathname;
          if (/^\/circuits\/transaction2\.(wasm|zkey)$/.test(path)) {
            res.setHeader("Content-Type", path.endsWith("wasm") ? "application/wasm" : "application/octet-stream");
            res.end(readFileSync(resolve(sdkRoot, path.slice(1))));
            return;
          }
          const name = path.match(/^\/api\/([a-z]+)$/)?.[1];
          if (!name) return next();
          try {
            const file = existsSync(resolve(server.config.root, `api/${name}.ts`)) ? `/api/${name}.ts` : `/api/${name}.js`;
            const mod = await (await apiModules(server.config.root)).ssrLoadModule(file);
            await mod.default(req, res);
          } catch (e) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "The service could not complete this request" }));
            console.error(e);
          }
        });
      },
    },
  ],
  build: { chunkSizeWarningLimit: 900 },
});
