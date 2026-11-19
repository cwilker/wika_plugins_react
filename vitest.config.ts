import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "@wika/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@wika/react": fileURLToPath(
        new URL("./packages/react/src/index.tsx", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.{ts,tsx}",
      "examples/owners/**/*.test.{ts,tsx}",
    ],
    restoreMocks: true,
  },
});
