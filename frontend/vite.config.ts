import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // registered in src/pwa.ts
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Oakhurst Basketball',
        short_name: 'Oakhurst',
        description: 'Check in, pay, and track your pickup basketball sessions.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f8f9fc',
        theme_color: '#16213a',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Check-in kiosk', url: '/kiosk', icons: [{ src: '/pwa-192.png', sizes: '192x192' }] },
          { name: 'My account', url: '/player', icons: [{ src: '/pwa-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        // App shell is precached; anything live (API, runtime config, Stripe/auth
        // redirects) always goes to the network so balances are never stale.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Non-Latin font subsets load only if a page needs those glyphs.
        globIgnores: ['config.js', '**/geist-cyrillic*', '**/geist-vietnamese*', '**/geist-latin-ext*'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          { urlPattern: ({ url }) => url.pathname.startsWith('/api/'), handler: 'NetworkOnly' },
          { urlPattern: ({ url }) => url.pathname === '/config.js', handler: 'NetworkFirst', options: { cacheName: 'runtime-config' } },
        ],
      },
    }),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
