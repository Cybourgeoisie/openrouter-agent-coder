// ESLint flat config.
//
// Layers (order matters):
//   1. eslint-config-prettier MUST be LAST in the export array — it disables
//      stylistic rules that conflict with Prettier (Prettier handles formatting).
//   2. typescript-eslint recommended rules apply to *.ts/*.tsx files only.
//   3. Test files relax a couple of recommended rules where they'd add noise
//      without catching real bugs (see comments inline).
//
// Why we don't enable the type-checked configs (recommendedTypeChecked):
//   Phase 0.2 scope is "lint baseline ends clean" with minimum-necessary fixes.
//   Type-checked rules require a parserOptions.project pass, materially slow
//   lint runs, and surface a much larger fix queue that belongs to Phase 1.x.
//   Revisit once the library refactor lands.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['dist/', 'coverage/', '.test-tmp/', 'node_modules/', 'logs/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.test.ts'],
    rules: {
      // Tests legitimately use `any` for SDK event fixtures and partial mocks
      // where the full type isn't useful; narrowing them adds noise without
      // catching real bugs.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
];
