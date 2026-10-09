import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Builds the MV3 extension into dist/. All executable code is bundled locally;
// public/manifest.json is copied verbatim.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    sourcemap: false,
    // Keep shipped code readable for review of an unpacked extension.
    minify: false,
    rollupOptions: {
      input: {
        dashboard: resolve(import.meta.dirname, 'dashboard.html'),
        background: resolve(import.meta.dirname, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
