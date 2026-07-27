import { defineConfig } from 'tsup';
import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

// Inject the real package version at build time so `cleak --version` matches the
// published package (package.json is NOT shipped in the tarball — `files` is just
// dist/LICENSE/NOTICE — so it can't be read at runtime).
export default defineConfig({
  entry: ['src/cli.ts'],
  define: { __CLEAK_VERSION__: JSON.stringify(pkg.version) },
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  bundle: true,
  noExternal: [/^@cleak\//],
  external: [
    'ink',
    'ink-text-input',
    'react',
    'commander',
    'uuid',
    'zod',
    '@modelcontextprotocol/sdk',
    'pdfkit',
  ],
  // Inject a React import so React.createElement calls resolve at runtime
  // when react is external (not bundled). The shim re-exports React from 'react'.
  inject: ['src/shims/react-shim.ts'],
  outDir: 'dist',
  clean: true,
  splitting: false,
  shims: false,
  dts: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
});
