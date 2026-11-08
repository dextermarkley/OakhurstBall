// Service worker + "update available".
//
// The app checks for a new version on load, whenever it comes back to the
// foreground, and every 15 minutes. When one is downloaded it does NOT reload on
// its own (that could interrupt someone mid-payment); instead an "Update" button
// appears (UpdateBanner). The unattended kiosk applies it itself the next time
// it's back on its name list.
//
// Pressing Update always goes to the LATEST version: it first asks the server
// again and waits for anything newer to finish downloading, then switches to
// whatever is newest. (Before, it switched to the version found by the last
// background check, which could be several deploys old, so the next launch
// offered yet another update.)
import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';

/** Build stamp, e.g. "2026.11.07-1432 · 0038ab6" (set in vite.config.ts). */
export const APP_VERSION: string = __APP_VERSION__;

type UpdateState = 'none' | 'ready' | 'updating';
let state: UpdateState = 'none';
let registration: ServiceWorkerRegistration | null = null;
const listeners = new Set<() => void>();
const set = (s: UpdateState) => {
  state = s;
  listeners.forEach((l) => l());
};

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  // On a first visit the worker downloads the whole app at once. Start it only
  // after this page has loaded, so the two don't compete for the server.
  const start = () => setTimeout(register, 3000);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

function register() {
  registerSW({
    immediate: true,
    onNeedRefresh() {
      if (state === 'none') set('ready');
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      registration = reg;
      const check = () => reg.update().catch(() => {});
      setInterval(check, 15 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.addEventListener('focus', check);
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve once a worker leaves the "installing" state (or after `ms`). */
function settled(sw: ServiceWorker, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (sw.state !== 'installing') return resolve();
    const done = () => {
      if (sw.state !== 'installing') {
        sw.removeEventListener('statechange', done);
        resolve();
      }
    };
    sw.addEventListener('statechange', done);
    setTimeout(resolve, ms);
  });
}

/**
 * Switch to the newest version and reload:
 *   1. ask the server for the latest worker (a deploy may have landed since the
 *      last background check) and wait for it to finish downloading;
 *   2. tell the newest waiting worker to take over;
 *   3. reload once it controls the page (or after a safety timeout).
 */
export async function applyUpdate() {
  if (state === 'updating') return;
  set('updating');
  const reg = registration ?? (await navigator.serviceWorker?.getRegistration().catch(() => undefined)) ?? null;
  if (!reg) return window.location.reload();

  let reloading = false;
  const reload = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });

  try {
    await Promise.race([reg.update(), sleep(8000)]);
  } catch {
    /* offline or server hiccup: fall back to what's already downloaded */
  }
  if (reg.installing) await settled(reg.installing, 30_000);

  const waiting = reg.waiting;
  if (!waiting) return reload(); // nothing waiting: just make sure the page is current
  waiting.postMessage({ type: 'SKIP_WAITING' });
  // If the switch is slow or the event never fires, reload anyway.
  setTimeout(reload, 10_000);
}

/** True once a new version is downloaded and waiting (or being applied). */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state !== 'none',
  );
}

/** True while Update is fetching and switching to the latest version. */
export function useUpdating(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state === 'updating',
  );
}
