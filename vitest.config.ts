import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const testDir = resolve(__dirname, ".");
const srcDir = resolve(__dirname, "src");

export default defineConfig({
  define: { __DEV__: true },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/unit/**/*.test.ts", "test/consistency/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    passWithNoTests: false,
    slowTestThreshold: 500,
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/types/**", "src/main.ts"],
    },
  },
  resolve: {
    alias: {
      "@util": resolve(srcDir, "util"),
      "@i18n": resolve(srcDir, "i18n"),
      "@chat": resolve(srcDir, "chat"),
      "@settings": resolve(srcDir, "settings"),
      "@renderer": resolve(srcDir, "renderer"),
      "@app": resolve(srcDir, "app"),
      "@translation": resolve(srcDir, "translation"),
      "@media": resolve(srcDir, "media"),
      "@shared": resolve(srcDir, "shared"),
      "@app-types": resolve(srcDir, "types/index"),
      "@platform": resolve(srcDir, "platform"),
    },
  },
});
