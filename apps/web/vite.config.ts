import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { pricesResponse } from "../../api/price";

const sdkSource = fileURLToPath(
  new URL("../../packages/sdk/src/index.ts", import.meta.url),
);

/**
 * The SDK is aliased to its TypeScript source — Vite compiles it directly
 * (ESM, tree-shakeable, no CJS-interop quirks from the tsc `dist` barrel).
 * The `dist` build remains the artifact for publishing and plain-Node use.
 *
 * The polyfill shim is load-bearing, not cosmetic: the SDK and web3.js v1
 * use Node `Buffer` at module scope (`pda.ts` seeds) plus `process`/`global`
 * in places — none of which exist in the browser. The static NODE_ENV
 * define complements the shim: libraries reading `process.env.NODE_ENV`
 * dynamically still select their production code path in `vite build`.
 */
/**
 * Serves `/api/price` in `vite dev` and `vite preview` with the same
 * handler Vercel runs, so the header tickers work locally. The key comes
 * from apps/web/.env(.local) as JUPITER_API_KEY — no VITE_ prefix, so it
 * never reaches the bundle.
 */
function priceApi(apiKey: string | undefined): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split("?")[0] !== "/api/price") return next();
    void pricesResponse(apiKey).then(async (response) => {
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(await response.text());
    }, next);
  };
  return {
    name: "orb-price-api",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    priceApi(loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "").JUPITER_API_KEY),
    react(),
    tailwindcss(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      "@orbit-jackpot/sdk": sdkSource,
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
    // Which ORB deployment the SDK targets (packages/sdk/src/pda.ts).
    // Unset = devnet; production sets VITE_ORB_CLUSTER=mainnet at launch.
    "process.env.ORB_CLUSTER": JSON.stringify(
      loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "").VITE_ORB_CLUSTER ?? "",
    ),
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Cache-stable chunks: the Solana stack is by far the heaviest
        // (web3.js v1 ~750 kB min) and changes rarely — app releases
        // shouldn't re-download it. 900 kB limit documents that the one
        // big chunk is the known, gzip-~250 kB solana bundle, not noise.
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          solana: [
            "@solana/web3.js",
            "@solana/wallet-adapter-base",
            "@solana/wallet-adapter-react",
            "@solana/wallet-adapter-react-ui",
            "@solana/wallet-adapter-phantom",
            "@solana/wallet-adapter-solflare",
          ],
          "ui-vendor": ["lucide-react", "@tanstack/react-query"],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  server: { port: 5173, strictPort: true },
}));
