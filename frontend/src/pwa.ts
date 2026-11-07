// Service worker registration. New versions activate on the next load
// (registerType: autoUpdate), so kiosks pick up deploys without a reinstall.
import { registerSW } from 'virtual:pwa-register';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      // Long-running kiosks: check for an update every hour.
      if (reg) setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    },
  });
}
