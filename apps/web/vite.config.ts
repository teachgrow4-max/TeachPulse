/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * In development the app and the API look like ONE site: requests to /api are proxied to the API.
 * That is what lets the HttpOnly refresh cookie (SameSite=Strict) work without special settings.
 * In production put both behind one domain, or follow the cookie notes in docs/AUTH.md.
 */
const API_URL = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_URL, changeOrigin: false },
    },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // The big libraries every page needs change rarely, so they get files of their own: a new
        // release of the app then only makes people download the part that actually changed.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            /node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run)\//.test(
              id,
            )
          )
            return 'react';
          if (id.includes('/@tanstack/')) return 'query';
          if (id.includes('/zod/')) return 'zod';
          if (id.includes('/lucide-react/')) return 'icons';
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
