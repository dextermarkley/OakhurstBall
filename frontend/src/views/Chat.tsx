// Club chat room: memes, logistics, whatever. Polls every few seconds while it's
// on screen; people who opt in get a notification for new messages (the server
// skips anyone who has the chat open).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, BellOff, Hourglass, ImagePlus, Loader2, MessagesSquare, SendHorizontal, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ChatMessage } from '@/api';
import { AppShell, type ShellUser } from '@/components/app-shell';
import { NotifyHelpDialog } from '@/components/notify-bar';
import { useConfirm } from '@/components/confirm';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { initials, timeOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useNotifications } from '@/notifications';
import { AuthGate } from './AuthGate';
import { markChatRead } from '@/chat-unread';

const POLL_MS = 4000;
const MAX_TEXT = 2000;

export function Chat() {
  return <AuthGate>{(signOut) => <ChatInner signOut={signOut} />}</AuthGate>;
}

function ChatInner({ signOut }: { signOut: () => void }) {
  const [me, setMe] = useState<any>(null);
  useEffect(() => {
    api.me().then(setMe).catch(() => {});
  }, []);
  const user: ShellUser = me ? { name: me.player?.name ?? me.name ?? me.email, email: me.email, isAdmin: me.isAdmin } : { name: '' };
  return (
    <AppShell section="Chat" user={user} onSignOut={signOut} hideNotifyBar fill>
      <ChatRoom isAdmin={!!me?.isAdmin} />
    </AppShell>
  );
}

function ChatRoom({ isAdmin }: { isAdmin: boolean }) {
  const confirm = useConfirm();
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [mySub, setMySub] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ChatMessage | null>(null);
  const since = useRef('');
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // keep pinned to the bottom unless the user scrolled up
  const keepOffset = useRef<number | null>(null);

  const last = messages?.[messages.length - 1];

  useEffect(() => {
    api
      .chat()
      .then((r) => {
        setMessages(r.messages);
        setHasMore(r.hasMore);
        setMySub(r.mySub);
        since.current = r.now;
      })
      .catch((e) => setError(e.message));
  }, []);

  const poll = useCallback(async () => {
    if (!messages || document.visibilityState !== 'visible') return;
    const after = messages[messages.length - 1]?.cursor ?? 'MSG#0000-00-00T00:00:00.000Z#000000000000000000000000';
    try {
      const r = await api.chatPoll(after, since.current);
      since.current = r.now;
      if (r.messages.length || r.deleted.length) {
        setMessages((cur) => {
          const gone = new Set(r.deleted);
          const have = new Set((cur ?? []).map((m) => m.messageId));
          return [...(cur ?? []).filter((m) => !gone.has(m.messageId)), ...r.messages.filter((m) => !have.has(m.messageId))];
        });
      }
    } catch {
      /* try again next tick */
    }
  }, [messages]);

  useEffect(() => {
    const t = setInterval(poll, POLL_MS);
    const onVis = () => document.visibilityState === 'visible' && poll();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [poll]);

  useEffect(() => {
    if (last) markChatRead(last.cursor);
  }, [last]);

  // Scroll: stay at the bottom for new messages; hold position when loading older.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (keepOffset.current != null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  async function loadOlder() {
    if (!messages?.length) return;
    setLoadingOlder(true);
    try {
      const r = await api.chat({ before: messages[0].cursor });
      keepOffset.current = (listRef.current?.scrollHeight ?? 0) - (listRef.current?.scrollTop ?? 0);
      setMessages((cur) => [...r.messages, ...(cur ?? [])]);
      setHasMore(r.hasMore);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoadingOlder(false);
    }
  }

  async function remove(m: ChatMessage) {
    const ok = await confirm({
      title: 'Delete this message?',
      description: m.sub === mySub ? 'It is removed for everyone.' : `This removes ${m.name}'s message for everyone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.chatDelete(m.cursor);
      setMessages((cur) => (cur ?? []).filter((x) => x.messageId !== m.messageId));
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  if (error === 'not_approved') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border bg-card p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-brand/10 text-brand">
          <Hourglass className="size-5" />
        </div>
        <div className="text-lg font-semibold">Waiting for approval</div>
        <p className="max-w-sm text-sm text-muted-foreground">
          The club chat is for approved members. An admin has been told you signed up and will approve your account soon. Everything
          else, like checking in and paying, works now.
        </p>
        <p className="text-xs text-muted-foreground">Turn on notifications and we’ll let you know when you’re approved.</p>
      </div>
    );
  }

  const onSent = (m: ChatMessage) => {
    stick.current = true;
    setMessages((cur) => ((cur ?? []).some((x) => x.messageId === m.messageId) ? cur : [...(cur ?? []), m]));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <MessagesSquare className="size-4 text-brand" />
        <div className="flex-1">
          <div className="text-sm font-semibold">Oakhurst chat</div>
          <div className="text-xs text-muted-foreground">Memes, logistics, anything. Everyone in the club can see it.</div>
        </div>
        <ChatNotifyToggle isAdmin={isAdmin} />
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {error ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : !messages ? (
          <div className="flex justify-center py-10">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <MessagesSquare className="size-8 opacity-40" />
            No messages yet. Say hi, or drop a meme.
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="mb-4 flex justify-center">
                <Button variant="outline" size="sm" disabled={loadingOlder} onClick={loadOlder}>
                  {loadingOlder && <Spinner />} Load earlier messages
                </Button>
              </div>
            )}
            <MessageList
              messages={messages}
              mySub={mySub}
              isAdmin={isAdmin}
              selected={selected}
              onSelect={(id) => setSelected((s) => (s === id ? null : id))}
              onDelete={remove}
              onView={setViewer}
            />
          </>
        )}
      </div>

      <Composer onSent={onSent} />

      <Dialog open={!!viewer} onOpenChange={(o) => !o && setViewer(null)}>
        <DialogContent className="max-h-[92dvh] w-auto max-w-[min(96vw,1100px)] p-2 sm:max-w-[min(96vw,1100px)]">
          <DialogTitle className="sr-only">Photo from {viewer?.name}</DialogTitle>
          {viewer?.image && (
            <img src={viewer.image.url} alt={`Photo from ${viewer.name}`} className="max-h-[86dvh] w-auto rounded-lg object-contain" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Messages ────────────────────────────────────────────────────────────────

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function MessageList({
  messages,
  mySub,
  isAdmin,
  selected,
  onSelect,
  onDelete,
  onView,
}: {
  messages: ChatMessage[];
  mySub: string;
  isAdmin: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onDelete: (m: ChatMessage) => void;
  onView: (m: ChatMessage) => void;
}) {
  const out: ReactNode[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
    const grouped =
      !newDay && prev.sub === m.sub && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
    if (newDay) {
      out.push(
        <div key={`d-${m.messageId}`} className="my-4 flex items-center gap-3 text-xs text-muted-foreground first:mt-0">
          <div className="h-px flex-1 bg-border" />
          {dayLabel(m.createdAt)}
          <div className="h-px flex-1 bg-border" />
        </div>,
      );
    }
    const mine = m.sub === mySub;
    const isSel = selected === m.messageId;
    out.push(
      <div key={m.messageId} className={cn('group flex gap-2', mine ? 'flex-row-reverse' : 'flex-row', grouped ? 'mt-0.5' : 'mt-3')}>
        <div className="w-8 shrink-0">
          {!grouped && !mine && (
            <Avatar className="size-8">
              <AvatarFallback className="bg-secondary text-[11px] font-medium">{initials(m.name)}</AvatarFallback>
            </Avatar>
          )}
        </div>
        <div className={cn('flex max-w-[78%] min-w-0 flex-col', mine ? 'items-end' : 'items-start')}>
          {!grouped && (
            <div className={cn('mb-1 flex items-baseline gap-2 px-1 text-xs', mine && 'flex-row-reverse')}>
              {!mine && <span className="font-medium text-foreground">{m.name}</span>}
              <span className="text-muted-foreground">{timeOf(m.createdAt)}</span>
            </div>
          )}
          <div className={cn('flex items-center gap-1', mine ? 'flex-row-reverse' : 'flex-row')}>
            <div
              onClick={() => onSelect(m.messageId)}
              className={cn(
                'min-w-0 overflow-hidden rounded-2xl text-left text-sm',
                m.text && (mine ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'),
                isSel && 'ring-2 ring-ring/40',
              )}
            >
              {m.image && (
                <ChatImage
                  m={m}
                  onOpen={(e) => {
                    e.stopPropagation();
                    onView(m);
                  }}
                />
              )}
              {m.text && <div className="px-3.5 py-2 break-words whitespace-pre-wrap">{linkify(m.text, mine)}</div>}
            </div>
            {(mine || isAdmin) && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete message"
                className={cn('shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100', isSel && 'opacity-100')}
                onClick={() => onDelete(m)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
          {isSel && grouped && <div className="mt-0.5 px-1 text-[11px] text-muted-foreground">{timeOf(m.createdAt)}</div>}
        </div>
      </div>,
    );
  });
  return <>{out}</>;
}

function ChatImage({ m, onOpen }: { m: ChatMessage; onOpen: (e: React.MouseEvent) => void }) {
  const w = m.image?.width;
  const h = m.image?.height;
  // Reserve the right box before it loads, so the list doesn't jump.
  const maxW = 280;
  const maxH = 320;
  const scale = w && h ? Math.min(1, maxW / w, maxH / h) : 1;
  const style = w && h ? { width: Math.round(w * scale), height: Math.round(h * scale) } : { maxWidth: maxW, maxHeight: maxH };
  return (
    <button type="button" onClick={onOpen} aria-label="View full size" className="block cursor-zoom-in bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <img src={m.image!.url} alt={m.text ? m.text.slice(0, 80) : `Photo from ${m.name}`} loading="lazy" style={style} className="block object-cover" />
    </button>
  );
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
function linkify(text: string, mine: boolean): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onClick={(e) => e.stopPropagation()}
        className={cn('underline underline-offset-2', mine ? 'text-primary-foreground' : 'text-brand')}
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

interface Attachment {
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

/** Downscale big photos in the browser (keeps uploads small); GIFs stay animated. */
async function prepareImage(file: File): Promise<Attachment> {
  if (!file.type.startsWith('image/')) throw new Error('That file isn’t an image');
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That image format isn’t supported');
  });
  const { width, height } = bitmap;
  const MAX = 1600;
  const okType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type);
  if (file.type === 'image/gif' || (okType && file.size <= 1.5 * 1024 * 1024 && Math.max(width, height) <= MAX)) {
    bitmap.close();
    if (file.size > 10 * 1024 * 1024) throw new Error('Images must be 10 MB or smaller');
    return { blob: file, url: URL.createObjectURL(file), width, height };
  }
  const s = Math.min(1, MAX / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * s);
  canvas.height = Math.round(height * s);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent PNGs → white, not black, as JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Couldn’t process that image');
  return { blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
}

function Composer({ onSent }: { onSent: (m: ChatMessage) => void }) {
  const [text, setText] = useState('');
  const [att, setAtt] = useState<Attachment | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [sending, setSending] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(
    () => () => {
      if (att?.url) URL.revokeObjectURL(att.url);
    },
    [att],
  );

  // Grow the textarea with its content, up to ~6 lines.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`;
  }, [text]);

  async function attach(file: File | undefined | null) {
    if (!file) return;
    setPreparing(true);
    try {
      setAtt(await prepareImage(file));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setPreparing(false);
    }
  }

  async function send() {
    const t = text.trim();
    if ((!t && !att) || sending) return;
    if (t.length > MAX_TEXT) return void toast.error(`Keep it under ${MAX_TEXT} characters.`);
    setSending(true);
    try {
      let imageKey: string | undefined;
      if (att) imageKey = await api.chatUpload(att.blob);
      const r = await api.chatSend({ text: t || undefined, imageKey, width: att?.width, height: att?.height });
      setText('');
      setAtt(null);
      onSent(r.message);
      taRef.current?.focus();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className={cn('border-t bg-background/60 p-2.5 sm:p-3', drag && 'bg-brand/5 ring-2 ring-brand/40 ring-inset')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        attach(e.dataTransfer.files?.[0]);
      }}
    >
      {(att || preparing) && (
        <div className="mb-2 flex items-center gap-2">
          <div className="relative">
            {att ? (
              <img src={att.url} alt="Attachment preview" className="h-20 max-w-40 rounded-lg border object-cover" />
            ) : (
              <div className="flex h-20 w-28 items-center justify-center rounded-lg border bg-muted">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {att && (
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => setAtt(null)}
                className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border bg-background shadow-sm"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            attach(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Add a photo or meme"
          disabled={sending || preparing}
          onClick={() => fileRef.current?.click()}
          className="shrink-0"
        >
          <ImagePlus />
        </Button>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          maxLength={MAX_TEXT}
          placeholder="Message the club"
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends on a keyboard; Shift+Enter (and phones) add a new line.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith('image/'));
            if (f) {
              e.preventDefault();
              attach(f);
            }
          }}
          className="max-h-[150px] min-h-10 flex-1 resize-none rounded-xl border bg-background px-3.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-sm"
        />
        <Button size="icon" aria-label="Send" disabled={sending || preparing || (!text.trim() && !att)} onClick={send} className="shrink-0 rounded-full">
          {sending ? <Spinner /> : <SendHorizontal />}
        </Button>
      </div>
    </div>
  );
}

// ── Notifications toggle (off by default) ──────────────────────────────────

function ChatNotifyToggle({ isAdmin }: { isAdmin: boolean }) {
  const n = useNotifications();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    api.chatPrefs().then((p) => setOn(p.chatNotify)).catch(() => setOn(false));
  }, []);

  async function toggle() {
    const next = !on;
    setBusy(true);
    try {
      await api.setChatPrefs(next);
      setOn(next);
      if (next && !n.subscribed) {
        setHelp(true); // the device itself still needs notifications turned on
      } else {
        toast.success(next ? 'You’ll get a notification for new chat messages.' : 'Chat notifications are off.');
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (on === null) return null;
  return (
    <>
      <Button
        variant={on ? 'secondary' : 'outline'}
        size="sm"
        aria-pressed={on}
        disabled={busy}
        onClick={toggle}
        title={on ? 'Turn off chat notifications' : 'Get a notification for new messages'}
      >
        {busy ? <Spinner /> : on ? <Bell /> : <BellOff />}
        <span className="hidden sm:inline">{on ? 'Notifying me' : 'Notify me'}</span>
        <span className="sm:hidden">{on ? 'On' : 'Off'}</span>
      </Button>
      <NotifyHelpDialog open={help} onClose={() => setHelp(false)} isAdmin={isAdmin} />
    </>
  );
}
