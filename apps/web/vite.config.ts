import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: the SPA runs on :5173 and proxies agent WebSockets and API calls to the Worker on :8787.
// Production: the Pages Function in functions/ forwards the same paths to the Worker over a service binding.
const api = "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true, proxy: { "/agents": { target: api, ws: true }, "/api": { target: api } } },
  build: { target: "es2022" },
});
