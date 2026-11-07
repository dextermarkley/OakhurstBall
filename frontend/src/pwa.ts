// Service worker registration.
//
// A phone or iPad can keep the app open (or resume an installed app) for days, so
// "check on page load" isn't enough: a stale bundle once misread a new API reply.
// We check for a new version whenever the app comes back to the foreground and
// every 15 minutes, and reload onto it as soon as it's installed
// (registerType: autoUpdate → the new worker takes control and the page reloads).
import { registerSW } from 'virtual:pwa-register';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => reg.update().catch(() => {});
      setInterval(check, 15 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.addEventListener('focus', check);
    },
  });
}
