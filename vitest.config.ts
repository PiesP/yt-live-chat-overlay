import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite-plus';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const srcDir = resolve(__dirname, 'src');

export default defineConfig({
  define: { __DEV__: true, __USERSCRIPT__: false },
  test: {
    // Preserve Vitest 4 mock history while validating the migrated test suite.
    clearMocks: false,
    globals: true,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: ['./test/setup.ts'],
          include: ['test/unit/**/*.test.ts', 'test/consistency/**/*.test.ts'],
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
