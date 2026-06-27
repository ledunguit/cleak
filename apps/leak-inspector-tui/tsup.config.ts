import { defineConfig } from 'tsup';
import { createRequire } from 'node:module';

// Inject the real package version at build time so `cleak --version` matches the
// published package (package.json is NOT shipped in the tarball — `files` is just
// dist/LICENSE/NOTICE — so it can't be read at runtime).
const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

// `cleak` is a self-contained CLI: the workspace libs (@cleak/agent-core,
// @cleak/common) are bundled INLINE so a global `npm i -g @cleak/cli` has no
// workspace deps; the npm runtime deps stay external (installed normally).
// Output is Node ESM with an executable shebang.
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
    // pdfkit is an OPTIONAL PDF renderer in @cleak/common (graceful `require`
    // in a try/catch). Keep it external so it is not inlined into the CLI bundle
    // — PDF export stays optional (install pdfkit yourself to enable it).
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
