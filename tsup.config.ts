import { defineConfig } from 'tsup';

export default defineConfig([
  // Main library — ESM + type declarations
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    platform: 'browser',
    outDir: 'dist',
    clean: true,
    sourcemap: true,
  },
  // AudioWorklet processor — IIFE, no imports, runs in audio thread
  {
    entry: { 'koe-worklet': 'src/engine/worklet.ts' },
    format: ['iife'],
    platform: 'browser',
    outDir: 'dist',
    sourcemap: false,
    minify: true,
    outExtension: () => ({ js: '.js' }),
  },
  // CLI converter — Node.js ESM
  {
    entry: { 'koe-convert': 'src/converter/cli.ts' },
    format: ['esm'],
    platform: 'node',
    outDir: 'dist',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: false,
  },
]);
