import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for the launcher's frontend logic (stores, pure helpers). Node environment: the
// covered code is plain TypeScript, no DOM. `@/` resolves to src/, matching tsconfig paths.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
