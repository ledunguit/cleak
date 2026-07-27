import { defineConfig } from 'tsup';
import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  entry: ['src/cli.ts'],
  define: { __CLEAK_VERSION__: JSON.stringify(pkg.version) },
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  bundle: true,
  // Bundle react inline so JSX transform (React.createElement) works at runtime
  // without needing a global React import. Ink, CLI deps, and PDF are external.
  noExternal: [/^@cleak\//, 'react'],
  external: [
    'ink',
    'ink-text-input',
    'commander',
    'uuid',
    'zod',
    '@modelcontextprotocol/sdk',
    'pdfkit',
  ],
  outDir: 'dist',
  clean: true,
  splitting: false,
  shims: false,
  dts: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
});
