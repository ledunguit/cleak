import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  bundle: true,
  noExternal: [],
  external: ['pino', 'pino-pretty', '@nestjs/common', '@cleak/common'],
  outDir: 'dist',
  clean: true,
  splitting: false,
  dts: true,
  sourcemap: false,
});
