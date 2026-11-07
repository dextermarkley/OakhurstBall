import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

// Version shown in the account menu: Pacific build time + git commit.
function appVersion() {
  const stamp = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date()).replace(/-/g, '.').replace(', ', '-').replace(':', '');
  let sha = '';
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) sha += '+';
  } catch { /* not a git checkout */ }
  return sha ? `${stamp} · ${sha}` : stamp;
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt', // show an Update button instead of reloading mid-task
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
