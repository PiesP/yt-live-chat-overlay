import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite-plus';
import { playwright } from 'vite-plus/test/browser-playwright';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const srcDir = resolve(__dirname, 'src');

export default defineConfig({
  define: { __DEV__: true, __USERSCRIPT__: false },
  optimizeDeps: {
    include: [
      '@piesp/browser-core/async',
      '@piesp/browser-core/design',
      '@piesp/browser-core/error',
      '@piesp/browser-core/locale',
      '@piesp/browser-core/util',
    ],
  },
  test: {
    // Preserve Vitest 4 mock history while validating the migrated test suite.
    clearMocks: false,
    globals: true,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          setupFiles: ['./test/setup.ts'],
          include: ['test/unit/**/*.test.ts', 'test/consistency/**/*.test.ts'],
          exclude: ['test/unit/**/*.browser.test.ts'],
        },
      },
      {
        test: {
          name: 'browser',
          setupFiles: ['./test/setup.ts'],
          include: ['test/unit/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        test: {
          name: 'node-policy',
          environment: 'node',
          include: [
            'scripts/ci/repository-authority.test.ts',
            'scripts/release/verify-source.test.ts',
            'scripts/release/verify-publication.test.ts',
          ],
        },
      },
    ],
    exclude: ['node_modules', 'dist'],
    passWithNoTests: false,
    maxWorkers: 8,
    slowTestThreshold: 500,
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', 'src/**/*.d.ts', 'src/main.ts'],
      thresholds: {
        statements: 56,
        branches: 44,
        functions: 65,
        lines: 58,
        'src/renderer/canvas/shared.ts': {
          statements: 44,
          branches: 38,
          functions: 63,
          lines: 44,
        },
        'src/renderer/worker/renderer.ts': {
          statements: 35,
          branches: 25,
          functions: 54,
          lines: 37,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@util': resolve(srcDir, 'util'),
      '@i18n': resolve(srcDir, 'i18n'),
      '@chat': resolve(srcDir, 'chat'),
      '@settings': resolve(srcDir, 'settings'),
      '@renderer': resolve(srcDir, 'renderer'),
      '@app': resolve(srcDir, 'app'),
      '@translation': resolve(srcDir, 'translation'),
      '@media': resolve(srcDir, 'media'),
      '@shared': resolve(srcDir, 'shared'),
      '@app-types': resolve(srcDir, 'types/index'),
      '@platform': resolve(srcDir, 'platform'),
    },
  },
});
