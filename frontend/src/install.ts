// "Install the app" on phones: which phone/browser this is, whether the app is
// already installed, and Android's one-tap install prompt.
import { useSyncExternalStore } from 'react';
import { isInstalled } from '@/notifications';
import { detectInstallKind, type InstallKind } from '@/install-detect';

export { detectInstallKind, type InstallKind };

// Android/Chrome fires beforeinstallprompt once the app is installable; keep it
// so the Install button can open the system dialog directly.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface InstallState {
  kind: InstallKind;
  installed: boolean;
  canPrompt: boolean;
  /** The bottom install bar is on screen (the Update pill moves up). */
  barVisible: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = {
  kind: typeof navigator === 'undefined' ? 'none' : detectInstallKind(),
  installed: typeof window === 'undefined' ? false : isInstalled(),
  canPrompt: false,
  barVisible: false,
};
const listeners = new Set<() => void>();
const set = (p: Partial<InstallState>) => {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own bar instead of Chrome's mini-infobar
    deferred = e as BeforeInstallPromptEvent;
    set({ canPrompt: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    set({ installed: true, canPrompt: false });
  });
}

export function useInstall(): InstallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function setInstallBarVisible(v: boolean): void {
  if (state.barVisible !== v) set({ barVisible: v });
}

/** Android: open the system install dialog. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  const e = deferred;
  deferred = null;
  set({ canPrompt: false });
  await e.prompt();
  const { outcome } = await e.userChoice;
  return outcome;
}

// "Not now" hides the bar for two weeks.
const SNOOZE_KEY = 'installSnoozedUntil';
export const isInstallSnoozed = () => Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now();
export const snoozeInstall = () => localStorage.setItem(SNOOZE_KEY, String(Date.now() + 14 * 86400_000));
