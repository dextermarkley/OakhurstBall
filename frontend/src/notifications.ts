// Notifications (Web Push) for the installed app.
//
// State lives in a tiny external store so the reminder bar, the help dialog, the
// account menu and the Update pill all agree. The server is told about this
// device whenever the app opens with permission granted (idempotent), so a new
// sign-in, a data reset or a rotated subscription heals itself.
import { useSyncExternalStore } from 'react';
import { api } from '@/api';

export type Platform = 'ios' | 'android' | 'mac-safari' | 'mac-chromium' | 'windows' | 'other';

export interface NotifyState {
  /** This browser can do Web Push at all. */
  supported: boolean;
  /** Running as the installed app (dock / start menu / home screen), not a tab. */
  installed: boolean;
  permission: NotificationPermission | 'unsupported';
  /** This device is registered with the server. null = not checked yet. */
  subscribed: boolean | null;
  busy: boolean;
  /** Last subscribe error (permission granted but registering failed). */
  error: string | null;
  platform: Platform;
}

const supported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    ['standalone', 'window-controls-overlay', 'fullscreen', 'minimal-ui'].some(
      (m) => window.matchMedia(`(display-mode: ${m})`).matches,
    ) || (navigator as any).standalone === true
  );
}

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS
  if (/iPhone|iPad|iPod/.test(ua) || touchMac) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh/.test(ua)) return /Chrome|Chromium|Edg\//.test(ua) ? 'mac-chromium' : 'mac-safari';
  return 'other';
}

let state: NotifyState = {
  supported: supported(),
  installed: isInstalled(),
  permission: supported() ? Notification.permission : 'unsupported',
  subscribed: null,
  busy: false,
  error: null,
  platform: typeof navigator === 'undefined' ? 'other' : detectPlatform(),
};
const listeners = new Set<() => void>();
const set = (patch: Partial<NotifyState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useNotifications(): NotifyState {
  return useSyncExternalStore(subscribe, () => state);
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The service worker registration, or null if none shows up (e.g. dev server). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((r) => setTimeout(() => r(null), 8000)),
  ]);
}

/** Get (or create) this device's push subscription and register it with the server. */
async function register(): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error('The app is still installing. Try again in a moment.');
  let sub = await reg.pushManager.getSubscription();
  const { publicKey } = await api.pushKey();
  const key = keyBytes(publicKey);
  // A subscription made with a different key can't receive our messages.
  if (sub) {
    const cur = sub.options.applicationServerKey;
    const same = cur && new Uint8Array(cur).every((b, i) => b === key[i]) && cur.byteLength === key.length;
    if (!same) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.pushSubscribe(sub.toJSON());
}

let syncing: Promise<void> | null = null;

/** Called when a signed-in page opens or the app comes back to the foreground. */
export function syncNotifications(): Promise<void> {
  if (!state.supported) return Promise.resolve();
  if (syncing) return syncing;
  syncing = (async () => {
    const permission = Notification.permission;
    set({ permission, installed: isInstalled() });
    if (permission !== 'granted') {
      set({ subscribed: false });
      return;
    }
    try {
      await register();
      set({ subscribed: true, error: null });
    } catch (e: any) {
      set({ subscribed: false, error: e?.message ?? 'Could not turn on notifications' });
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

/** Ask for permission (must run from a click) and register. Returns the outcome. */
export async function enableNotifications(): Promise<'on' | 'denied' | 'dismissed' | 'error'> {
  if (!state.supported) return 'error';
  set({ busy: true, error: null });
  try {
    const permission = await Notification.requestPermission();
    set({ permission });
    if (permission === 'denied') return 'denied';
    if (permission !== 'granted') return 'dismissed';
    await register();
    set({ subscribed: true });
    api.pushTest().catch(() => {});
    return 'on';
  } catch (e: any) {
    set({ subscribed: false, error: e?.message ?? 'Could not turn on notifications' });
    return 'error';
  } finally {
    set({ busy: false });
  }
}

/** Stop notifications on this device (also used on sign-out, before the token goes). */
export async function disableNotifications(): Promise<void> {
  if (!state.supported) return;
  try {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api.pushUnsubscribe(sub.endpoint).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } finally {
    set({ subscribed: false });
  }
}

// Re-check when the user comes back (e.g. from System Settings) or permission changes.
if (state.supported) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Notification.permission !== state.permission && signedIn) {
      void syncNotifications();
    }
  });
  navigator.permissions
    ?.query({ name: 'notifications' as PermissionName })
    .then((p) => {
      p.onchange = () => signedIn && void syncNotifications();
    })
    .catch(() => {});
  window.matchMedia('(display-mode: standalone)').addEventListener?.('change', () => set({ installed: isInstalled() }));
}

let signedIn = false;
/** Signed-in pages mark themselves so background re-checks only run with a token. */
export function setSignedIn(v: boolean) {
  signedIn = v;
  if (v) void syncNotifications();
}

// ── Reminder bar visibility (the Update pill moves up when it's showing) ──
let barVisible = false;
const barListeners = new Set<() => void>();
export function setNotifyBarVisible(v: boolean) {
  if (v === barVisible) return;
  barVisible = v;
  barListeners.forEach((l) => l());
}
export function useNotifyBarVisible(): boolean {
  return useSyncExternalStore(
    (l) => {
      barListeners.add(l);
      return () => barListeners.delete(l);
    },
    () => barVisible,
  );
}
