import { defineConfig } from 'vite-plus';

import { createUserscriptConfig } from './tooling/vite/configs/userscript.ts';

// These existing fixtures predate type-aware lint; native type checking still covers them.
const fixtureTypeAwareBaseline = {
  'typescript/unbound-method': 'off',
  'typescript/no-floating-promises': 'off',
  'typescript/no-base-to-string': 'off',
  'typescript/no-redundant-type-constituents': 'off',
  'typescript/restrict-template-expressions': 'off',
  'typescript/require-array-sort-compare': 'off',
  'typescript/no-misused-spread': 'off',
  'typescript/await-thenable': 'off',
} as const;

export default defineConfig((env) => ({
  ...createUserscriptConfig(env),
  run: {
    // Builds, release guards and receipts must execute for every invocation.
    cache: false,
    tasks: {
      'quality-gate': [
        "vp check src scripts extension test tooling validation/windows .github/actions '*.ts' '*.json'",
        'vp run test:ci',
        'vp run check:i18n',
      ],
      'quality-fix-gate': [
        "vp check --fix src scripts extension test tooling validation/windows .github/actions '*.ts' '*.json'",
        'vp run quality',
      ],
      'prebuild-gate': ['vp run check:versions', 'vp run quality'],
      'verify-gate': ['vp run quality', 'vp run check:versions', 'vp run build:targets:ci'],
      'verify-full-gate': [
        'vp run verify',
        'vp run test:core',
        'vp run test:cov',
        'vp run test:e2e:prepared',
      ],
      'chrome-build': [
        'vp build --config vite.config.extension.ts',
        'vp build --config vite.config.extension.cs.ts',
        'vp build --config vite.config.extension.page.ts',
      ],
      'chrome-dev-build': [
        'vp build --mode development',
        'vp build --config vite.config.extension.ts --mode development',
        'vp build --config vite.config.extension.cs.ts --mode development',
        'vp build --config vite.config.extension.page.ts --mode development',
      ],
      'firefox-build': [
        'vp build --config vite.config.extension.firefox.ts',
        'vp build --config vite.config.extension.cs.firefox.ts',
        'vp build --config vite.config.extension.page.firefox.ts',
      ],
      'production-build': [
        'vp run build:ci',
        'vp run build:extension:ci',
        'vp run build:extension:firefox:ci',
        'vp run check:artifacts',
      ],
      'build-all-ci-gate': [
        'vp run check:versions',
        'vp run check:i18n',
        'vp run build:targets:ci',
      ],
      'core-verify': [
        'cd packages/core && vp install --frozen-lockfile -- --no-runtime',
        'cd packages/core && vp run verify',
      ],
      'e2e-prepare': [
        'vp run build:dev',
        'vp run build:extension:ci',
        'vp run build:extension:firefox:ci',
        'vp run check:artifacts --e2e',
      ],
      'e2e-prepared': [
        'vp run build:dev',
        'vp run check:artifacts --e2e',
        'playwright test --config test/e2e/playwright.config.ts',
      ],
    },
  },
  fmt: {
    useTabs: false,
    tabWidth: 2,
    printWidth: 100,
    singleQuote: true,
    trailingComma: 'es5',
    semi: true,
    arrowParens: 'always',
    sortImports: {},
    sortPackageJson: false,
    ignorePatterns: [
      'packages/core/**',
      '**/dist*/**',
      '**/coverage/**',
      '**/reports/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/.cache/**',
      '**/browser-profiles/**',
      '**/vendor/**',
      'test/**/*.html',
    ],
  },
  lint: {
    plugins: ['unicorn', 'typescript', 'oxc', 'import'],
    options: { typeAware: true, typeCheck: true, maxWarnings: 0 },
    categories: { correctness: 'error' },
    rules: {
      'no-unused-vars': [
        'error',
        { caughtErrorsIgnorePattern: '^_', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'typescript/no-non-null-assertion': 'warn',
      'prefer-const': 'error',
      'no-param-reassign': 'warn',
      'typescript/no-unnecessary-template-expression': 'error',
      'prefer-exponentiation-operator': 'error',
      'typescript/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      'typescript/no-explicit-any': 'error',
      'no-unneeded-ternary': 'error',
      'unicorn/no-useless-switch-case': 'error',
      'typescript/no-useless-empty-export': 'error',
      'no-lone-blocks': 'error',
      'oxc/no-accumulating-spread': 'error',
      'import/no-cycle': ['error', { ignoreTypes: false, ignoreExternal: false }],
      'typescript/triple-slash-reference': 'off',
      'unicorn/no-useless-fallback-in-spread': 'off',
      'unicorn/no-useless-spread': 'off',
      'unicorn/prefer-string-starts-ends-with': 'off',
    },
    overrides: [
      { files: ['src/**', 'extension/**'], rules: { 'typescript/no-non-null-assertion': 'error' } },
      {
        files: ['test/**', 'scripts/**/*.test.ts'],
        rules: {
          ...fixtureTypeAwareBaseline,
          'typescript/no-non-null-assertion': 'off',
          'no-template-curly-in-string': 'off',
        },
      },
      {
        // Windows acceptance helpers predate type-aware lint. Preserve floating-promise checks.
        files: ['validation/windows/**/*.ts'],
        rules: { ...fixtureTypeAwareBaseline, 'typescript/no-floating-promises': 'error' },
      },
      {
        files: ['validation/windows/**/*.test.ts'],
        rules: fixtureTypeAwareBaseline,
      },
      {
        // These callbacks are static or keep their receiver at the call site.
        files: [
          'src/chat/fetch-interceptor.ts',
          'src/renderer/canvas-renderer.ts',
          'src/renderer/worker/renderer.ts',
        ],
        rules: { 'typescript/unbound-method': 'off' },
      },
      {
        files: ['src/platform/storage-adapters.ts'],
        rules: {
          'typescript/no-base-to-string': 'off',
          'typescript/await-thenable': 'off',
        },
      },
      {
        files: ['src/main.ts'],
        rules: { 'typescript/await-thenable': 'off' },
      },
      {
        files: ['src/renderer/canvas/shared.ts'],
        rules: { 'typescript/no-misused-spread': 'off' },
      },
      {
        files: [
          'src/chat/message-helpers.ts',
          'src/settings/schema.ts',
          'validation/windows/chrome-install.ts',
        ],
        rules: { 'no-control-regex': 'off' },
      },
      {
        files: ['src/platform/chrome-types.d.ts', 'src/renderer/canvas/shared.ts'],
        rules: { 'typescript/no-invalid-void-type': 'off' },
      },
      {
        files: [
          'test/unit/app/standby-controller.test.ts',
          'test/browser/settings/ui/controller.browser.test.ts',
          'test/browser/worker/manager.browser.test.ts',
          'test/unit/worker/renderer.test.ts',
        ],
        rules: { 'typescript/no-explicit-any': 'off' },
      },
      { files: ['src/settings/defaults.ts'], rules: { 'oxc/no-accumulating-spread': 'off' } },
      { files: ['test/e2e/specs/firefox-extension.spec.ts'], rules: { 'no-empty-pattern': 'off' } },
      {
        files: [
          'test/browser/core/canvas-render-mock.browser.test.ts',
          'test/browser/core/vertical-spacing.browser.test.ts',
        ],
        rules: { 'no-constructor-return': 'off' },
      },
      {
        files: ['validation/windows/chrome-install.ts', 'validation/windows/natural-chrome.ts'],
        rules: { 'no-unsafe-finally': 'off' },
      },
    ],
    ignorePatterns: [
      'packages/core/**',
      '**/dist*/**',
      '**/coverage/**',
      '**/reports/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/.cache/**',
      '**/browser-profiles/**',
      '**/vendor/**',
      'test/**/*.html',
    ],
  },
}));
