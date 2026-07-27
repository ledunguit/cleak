import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  bundle: true,
  noExternal: [],
  external: ['zod', '@cleak/agent-core'],
  outDir: 'dist',
  clean: true,
  splitting: false,
  dts: true,
  sourcemap: false,
});
