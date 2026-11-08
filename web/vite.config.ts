/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// The browser talks only to this origin; /api is forwarded to the Express server.
const proxy = { '/api': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: false } };

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // FR-48. Only the app's own files are stored on the phone, plus the emergency numbers (FR-52), which are not
    // private. Nothing else under /api matches, so bills, payments, requests and profiles are never kept on the device.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['offline.html', 'offline.js', 'icons/*.png'],
      manifest: {
        name: 'Apartment Management',
        short_name: 'Apartment',
        description: 'Bills, payments, maintenance and notices for your building.',
        theme_color: '#0a1512',
        background_color: '#0a1512',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png}'],
        navigateFallback: null,
        // Pages always come from the network; without one, the friendly offline page replaces the browser's error.
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkOnly',
            options: { precacheFallback: { fallbackURL: 'offline.html' } },
          },
          {
            urlPattern: ({ url }) => url.pathname === '/api/emergency-contacts',
            method: 'GET',
            handler: 'NetworkFirst',
            options: { cacheName: 'emergency-contacts', networkTimeoutSeconds: 4, cacheableResponse: { statuses: [200] } },
          },
        ],
      },
    }),
  ],
  server: { port: 5173, proxy },
  preview: { proxy },
  test: {
    environment: 'jsdom',
    globals: false,
    coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], reporter: ['text-summary', 'html', 'lcov'] },
  },
});
