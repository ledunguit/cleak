import { defineConfig } from 'tsup';

// @cleak/common ships the subpaths its consumers import: the barrel, `./types`,
// `./flow/scan-flow-contract`, and every `./analysis/*` module. Code shared
// across these entries is split into chunks so it is not duplicated. `zod` and
// the optional `pdfkit` (PDF report renderer) stay external.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/types/index.ts',
    'src/flow/scan-flow-contract.ts',
    'src/constants/*.ts',
    'src/analysis/*.ts',
    'src/mcp/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
  ],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  bundle: true,
  splitting: true,
  external: ['zod', 'pdfkit'],
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: false,
  tsconfig: 'tsconfig.lib.json',
});
