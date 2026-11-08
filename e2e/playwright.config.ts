// Browser end-to-end tests against ALPHA (alpha.oakhurst-ball.org).
//   cd e2e && npm test                 all specs
//   npx playwright test kiosk          one spec
//   npx playwright show-report         last run's report (screenshots, traces)
// Real WebKit (Safari's engine: iPhones, iPads, Macs), real API, real Cognito,
// Stripe test mode. Every spec makes its own throwaway data and removes it.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  // Specs share alpha's one "current session" and "current announcement", so
  // run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'https://alpha.oakhurst-ball.org',
    browserName: 'webkit',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    { name: 'phone', use: { ...devices['iPhone 15'], browserName: 'webkit' }, testMatch: /(signup|player|chat|stripe)\.spec\.ts/ },
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } }, testMatch: /(admin|kiosk|layout)\.spec\.ts/ },
  ],
});
