import { defineConfig } from "vitest/config";

/**
 * Pure-logic unit tests run in node; component tests opt into the DOM
 * per-file with a `@vitest-environment happy-dom` docblock — the logic
 * suites stay DOM-free by construction.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
  },
});
