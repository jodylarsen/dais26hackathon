import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  server: {
    middlewareMode: true,
  },
  build: {
    outDir: path.resolve(__dirname, './dist'),
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV === 'development',
    rollupOptions: {
      output: {
        // Keep maplibre in its own chunk — hash changes only when maplibre
        // itself updates, not on every app code change.
        manualChunks(id) {
          if (id.includes('maplibre-gl') || id.includes('react-map-gl')) {
            return 'maplibre';
          }
        },
      },
    },
  },
  optimizeDeps: {
    // Pre-bundle maplibre in dev so HMR doesn't re-transform 800 KB on each reload.
    include: [
      'react', 'react-dom', 'react/jsx-dev-runtime', 'react/jsx-runtime',
      'recharts', 'maplibre-gl', 'react-map-gl/maplibre',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
