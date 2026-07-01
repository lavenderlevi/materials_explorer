import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // In dev, proxy /api/* → FastAPI on :8000
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  // Production build goes to api/static/dist/ so FastAPI can serve it
  build: {
    outDir: "../api/static/dist",
    emptyOutDir: true,
  },
});
