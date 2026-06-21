import { defineConfig } from "vitest/config";

// Keep the Tauri-tailored vite.config.ts untouched; vitest uses this node-env config.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
