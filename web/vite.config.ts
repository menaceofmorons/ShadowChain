import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
});
