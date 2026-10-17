import { defineConfig } from 'vite-plus';

import { createUserscriptConfig } from './tooling/vite/configs/userscript.ts';

export default defineConfig((env) => ({
  ...createUserscriptConfig(env),
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
    options: { typeAware: false, typeCheck: false, maxWarnings: 0 },
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
      'typescript/triple-slash-reference': 'off',
      'unicorn/no-useless-fallback-in-spread': 'off',
      'unicorn/no-useless-spread': 'off',
      'unicorn/prefer-string-starts-ends-with': 'off',
    },
    overrides: [
      { files: ['src/**', 'extension/**'], rules: { 'typescript/no-non-null-assertion': 'error' } },
      {
        files: ['test/**', 'scripts/**/*.test.ts'],
        rules: { 'typescript/no-non-null-assertion': 'off', 'no-template-curly-in-string': 'off' },
      },
      {
        files: [
          'src/chat/message-helpers.ts',
          'src/settings/schema.ts',
          'validation/windows/chrome-install.mjs',
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
          'test/unit/settings/ui/controller.test.ts',
          'test/unit/worker/manager.test.ts',
          'test/unit/worker/renderer.test.ts',
        ],
        rules: { 'typescript/no-explicit-any': 'off' },
      },
      { files: ['src/settings/defaults.ts'], rules: { 'oxc/no-accumulating-spread': 'off' } },
      { files: ['test/e2e/specs/firefox-extension.spec.ts'], rules: { 'no-empty-pattern': 'off' } },
      {
        files: [
          'test/unit/core/canvas-render-mock.test.ts',
          'test/unit/core/vertical-spacing.test.ts',
        ],
        rules: { 'no-constructor-return': 'off' },
      },
      {
        files: ['validation/windows/chrome-install.mjs', 'validation/windows/natural-chrome.mjs'],
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
