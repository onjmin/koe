import { cpSync, mkdirSync } from 'node:fs';
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
    // Bundle fflate — consumers load this file directly as a <script type="module">
    // with no bundler of their own, so bare specifiers must be inlined.
    noExternal: ['fflate'],
    // Ship the worldline WASM assets so consumers can load them from the
    // package (e.g. via a CDN: <cdn>/@onjmin/koe/dist/world/worldline.js).
    async onSuccess() {
      mkdirSync('dist/world', { recursive: true });
      cpSync('demo/world', 'dist/world', { recursive: true });
      mkdirSync('dist/utautts', { recursive: true });
      cpSync('demo/utautts', 'dist/utautts', { recursive: true });
    },
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
    sourcemap: false,
  },
  // CLI oto.ini generator — Node.js ESM
  {
    entry: { 'koe-oto': 'src/oto/cli.ts' },
    format: ['esm'],
    platform: 'node',
    outDir: 'dist',
    sourcemap: false,
  },
]);
