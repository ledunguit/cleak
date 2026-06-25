import { defineConfig } from 'tsup';

// @cleak/agent-core is a standalone library: barrel-only public surface, ESM,
// with type declarations. Its npm deps stay external (installed by consumers).
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  bundle: true,
  external: ['@modelcontextprotocol/sdk', 'zod'],
  outDir: 'dist',
  clean: true,
  dts: true,
  splitting: false,
  sourcemap: false,
});
