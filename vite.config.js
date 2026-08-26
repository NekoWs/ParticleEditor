import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    rolldownOptions: {
      output: {
        // 把 three 单独拆包，避免主 bundle 过大并改善浏览器缓存命中。
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/*.test.js'],
    globals: true,
    setupFiles: ['test/setup.js'],
  },
});