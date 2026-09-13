import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The FastAPI backend has no CORS middleware, so requests to /api are
// proxied to it during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
