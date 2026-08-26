import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'node',
    include: ['test/*.test.js'],
    globals: true,
    setupFiles: ['test/setup.js'],
  },
});