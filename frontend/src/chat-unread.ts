// "New chat messages" dot on the Chat button. The newest message cursor is
// compared with the last one this device has shown in the chat.
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '@/api';

const KEY = 'chatReadCursor';
let latest: { cursor: string | null; mine: boolean } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function markChatRead(cursor: string) {
  const cur = localStorage.getItem(KEY) ?? '';
  if (cursor > cur) localStorage.setItem(KEY, cursor);
  emit();
}

function unread(): boolean {
  if (!latest?.cursor || latest.mine) return false;
  return latest.cursor > (localStorage.getItem(KEY) ?? '');
}

/** True when someone else has posted since this device last opened the chat. */
export function useChatUnread(enabled: boolean): boolean {
  useEffect(() => {
    if (!enabled) return;
    const check = () =>
      document.visibilityState === 'visible' &&
      api
        .chatLatest()
        .then((r) => {
          latest = r;
          emit();
        })
        .catch(() => {});
    check();
    const t = setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', check);
    };
  }, [enabled]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    unread,
  );
}
