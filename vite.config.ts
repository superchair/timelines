import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.PORT ?? '3001';
const target = `http://localhost:${apiPort}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': target,
      '/auth': target,
    },
  },
});
