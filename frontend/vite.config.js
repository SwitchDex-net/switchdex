import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the SwitchDex UI into dist/ as static files (index.html + hashed JS/CSS).
// The Dockerfile copies dist/ into Caddy's /srv/www. esbuild handles the .jsx.
export default defineConfig({
  plugins: [react()],
  esbuild: { loader: "jsx", include: /\.[jt]sx?$/ },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
