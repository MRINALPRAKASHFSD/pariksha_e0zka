import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const apiPort = process.env.VITE_API_PORT ?? "4000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      "/socket.io": {
        target: `http://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
});
