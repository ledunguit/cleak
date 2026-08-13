// @ts-check
/**
 * ESLint flat config (repo root) — the single source of truth for linting.
 *
 * Scope: everything under `apps/` and `packages/`. The root `lint` script runs
 * `eslint apps packages --max-warnings=0`; each workspace package's `lint`
 * script runs `eslint .` so the turbo `lint` task does real work too (both
 * resolve this same config by walking up from the package directory).
 *
 * Deliberately NON-stylistic: typescript-eslint `recommended` (correctness
 * rules only) + a handful of high-signal sanity rules. No formatting rules —
 * Prettier owns formatting — so linting never triggers a reformatting storm.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Never lint build output / deps / generated artifacts.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/runs/**',
      '**/results/**',
      '**/*.d.ts',
      'eslint.config.mjs',
    ],
  },
  // Core recommended rules — applies to the plain-JS files in the workspace
  // (e.g. apps/static-analyzer/webpack.config.js). For .ts/.tsx the blocks
  // below supersede the TS-incompatible core rules (no-undef / no-unused-vars
  // are turned off for TS by typescript-eslint recommended).
  js.configs.recommended,
  // TypeScript-aware recommended rules (correctness, no type-checking needed).
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Plain-JS files here are CommonJS configs (webpack.config.js) — `require`
      // is the native module system for them, not a style violation.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Sanity rules — small, high-signal, applied to every linted file.
    rules: {
      // Deliberately OFF: the codebase uses `any` pervasively in tests and
      // adapter boundaries, and the previous .eslintrc turned this off too.
      // It is a type-purity preference, not a bug — leave it off to keep the
      // lint signal focused on real problems.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-async-promise-executor': 'error',
      'no-constant-binary-expression': 'error',
      'prefer-const': 'error',
    },
  },
);
