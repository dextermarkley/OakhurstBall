// Service worker + "update available".
//
// The app checks for a new version on load, whenever it comes back to the
// foreground, and every 15 minutes. When one is downloaded it does NOT reload on
// its own (that could interrupt someone mid-payment); instead an "Update" button
// appears (UpdateBanner). The unattended kiosk applies it itself the next time
// it's back on its name list.
import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';

/** Build stamp, e.g. "2026.11.07-1432 · 0038ab6" (set in vite.config.ts). */
export const APP_VERSION: string = __APP_VERSION__;

let ready = false;
let apply: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      ready = true;
      emit();
    },
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

/** Switch to the downloaded version and reload. */
export function applyUpdate() {
  if (apply) apply(true);
  else window.location.reload();
}

/** True once a new version is downloaded and waiting. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ready,
  );
}
