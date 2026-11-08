// Club chat room: memes, logistics, whatever. Polls every few seconds while it's
// on screen; people who opt in get a notification for new messages (the server
// skips anyone who has the chat open). Tap a message for quick reactions and
// Reply; double-tap to ❤️; hover on a desktop shows the same actions.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, BellOff, Hourglass, ImagePlus, Loader2, MessagesSquare, Reply, SendHorizontal, SmilePlus, Trash2, X } from 'lucide-react';
import { EmojiPicker } from 'frimousse';
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
const QUICK = ['👍', '❤️', '😂', '🔥', '🏀', '😮'];
const DOUBLE_TAP = '❤️';

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
  const [notifyHelp, setNotifyHelp] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ChatMessage | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [pickerFor, setPickerFor] = useState<ChatMessage | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
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
      const updated = r.updated ?? [];
      if (r.messages.length || r.deleted.length || updated.length) {
        setMessages((cur) => {
          const gone = new Set(r.deleted);
          const fresh = new Map(updated.map((m) => [m.messageId, m]));
          const have = new Set((cur ?? []).map((m) => m.messageId));
          return [
            ...(cur ?? []).filter((m) => !gone.has(m.messageId)).map((m) => fresh.get(m.messageId) ?? m),
            ...r.messages.filter((m) => !have.has(m.messageId)),
          ];
        });
        if (replyTo && r.deleted.includes(replyTo.messageId)) setReplyTo(null);
      }
    } catch {
      /* try again next tick */
    }
  }, [messages, replyTo]);

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

  const put = (m: ChatMessage) => setMessages((cur) => (cur ?? []).map((x) => (x.messageId === m.messageId ? m : x)));

  /** Toggle my reaction: shown at once, then replaced by what the server says. */
  async function toggleReaction(m: ChatMessage, emoji: string) {
    const cur = m.reactions ?? [];
    const on = !cur.find((r) => r.emoji === emoji)?.subs.includes(mySub);
    // Only this emoji changes; my other reactions on the message stay.
    let next = cur.map((r) => (r.emoji !== emoji ? r : { ...r, subs: on ? [...r.subs, mySub] : r.subs.filter((x) => x !== mySub) }));
    if (on && !cur.some((r) => r.emoji === emoji)) next = [...next, { emoji, subs: [mySub] }];
    put({ ...m, reactions: next.filter((r) => r.subs.length) });
    setSelected(null);
    try {
      put((await api.chatReact(m.cursor, emoji, on)).message);
    } catch (e: any) {
      put(m);
      toast.error(e.message);
    }
  }

  function startReply(m: ChatMessage) {
    setReplyTo(m);
    setSelected(null);
    document.getElementById('chat-composer')?.focus();
  }

  /** Scroll to the quoted message and flash it (if it's loaded). */
  function jumpTo(messageId: string) {
    const el = document.getElementById(`m-${messageId}`);
    if (!el) return void toast('That message is further back. Tap “Load earlier messages”.');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(messageId);
    setTimeout(() => setFlash((f) => (f === messageId ? null : f)), 1500);
  }

  // Who reacted, by name, for the tooltips (people who've posted in what's loaded).
  const names = new Map((messages ?? []).map((m) => [m.sub, m.name]));

  async function remove(m: ChatMessage) {
    const ok = await confirm({
      title: 'Delete this message?',
      description: m.sub === mySub ? 'This removes it for everyone.' : `This removes ${m.name}’s message for everyone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.chatDelete(m.cursor);
      setMessages((cur) => (cur ?? []).filter((x) => x.messageId !== m.messageId));
      if (replyTo?.messageId === m.messageId) setReplyTo(null);
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
        <Button size="sm" variant="outline" onClick={() => setNotifyHelp(true)}>
          <Bell /> Turn on notifications
        </Button>
        <NotifyHelpDialog open={notifyHelp} onClose={() => setNotifyHelp(false)} isAdmin={isAdmin} />
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
          <div className="text-xs text-muted-foreground">Memes, logistics, anything. Every approved member can see it.</div>
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
          <p className="py-10 text-center text-sm text-destructive">Couldn’t load the chat. Check your connection and reload.</p>
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
              onReact={toggleReaction}
              onReply={startReply}
              onMore={(m) => {
                setPickerFor(m);
                setSelected(null);
              }}
              onJump={jumpTo}
              flash={flash}
              names={names}
            />
          </>
        )}
      </div>

      {messages && !error && <Composer onSent={onSent} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} mySub={mySub} />}

      <Dialog open={!!pickerFor} onOpenChange={(o) => !o && setPickerFor(null)}>
        <DialogContent className="w-[min(92vw,360px)] gap-2 p-3">
          <DialogTitle className="text-sm">React to {pickerFor?.sub === mySub ? 'your message' : `${pickerFor?.name}’s message`}</DialogTitle>
          <EmojiPicker.Root
            emojibaseUrl="/emojibase"
            columns={8}
            className="flex h-[340px] flex-col"
            onEmojiSelect={({ emoji }) => {
              const m = pickerFor;
              setPickerFor(null);
              if (m) toggleReaction(m, emoji);
            }}
          >
            <EmojiPicker.Search
              aria-label="Search emoji"
              placeholder="Search emoji"
              className="mb-2 h-9 rounded-lg border bg-background px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-sm"
            />
            <EmojiPicker.Viewport className="relative flex-1 outline-none">
              <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                Loading…
              </EmojiPicker.Loading>
              <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                No emoji found.
              </EmojiPicker.Empty>
              <EmojiPicker.List
                className="pb-2 select-none"
                components={{
                  CategoryHeader: ({ category, ...props }) => (
                    <div {...props} className="bg-popover px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                      {category.label}
                    </div>
                  ),
                  Row: ({ children, ...props }) => (
                    <div {...props} className="flex">
                      {children}
                    </div>
                  ),
                  Emoji: ({ emoji, ...props }) => (
                    <button
                      {...props}
                      aria-label={emoji.label}
                      className={cn('flex size-10 items-center justify-center rounded-lg text-2xl', emoji.isActive && 'bg-muted')}
                    >
                      {emoji.emoji}
                    </button>
                  ),
                }}
              />
            </EmojiPicker.Viewport>
          </EmojiPicker.Root>
        </DialogContent>
      </Dialog>

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
  onReact,
  onReply,
  onMore,
  onJump,
  flash,
  names,
}: {
  messages: ChatMessage[];
  mySub: string;
  isAdmin: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onDelete: (m: ChatMessage) => void;
  onView: (m: ChatMessage) => void;
  onReact: (m: ChatMessage, emoji: string) => void;
  onReply: (m: ChatMessage) => void;
  onMore: (m: ChatMessage) => void;
  onJump: (messageId: string) => void;
  flash: string | null;
  names: Map<string, string>;
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
      <div
        key={m.messageId}
        id={`m-${m.messageId}`}
        className={cn('group flex gap-2 rounded-xl transition-colors', mine ? 'flex-row-reverse' : 'flex-row', grouped ? 'mt-0.5' : 'mt-3', flash === m.messageId && 'bg-brand/10')}
      >
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
              onDoubleClick={(e) => {
                e.preventDefault();
                onReact(m, DOUBLE_TAP);
              }}
              data-testid="bubble"
              className={cn(
                'min-w-0 cursor-pointer overflow-hidden rounded-2xl text-left text-sm [touch-action:manipulation]',
                (m.text || m.replyTo) && (mine ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'),
                isSel && 'ring-2 ring-ring/40',
              )}
            >
              {m.replyTo && <Quote q={m.replyTo} mine={mine} mySub={mySub} onJump={onJump} />}
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
            <div className={cn('flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100', isSel && 'opacity-100', mine && 'flex-row-reverse')}>
              <Button variant="ghost" size="icon-sm" aria-label="React" className="text-muted-foreground" onClick={() => onSelect(m.messageId)}>
                <SmilePlus />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Reply" className="text-muted-foreground" onClick={() => onReply(m)}>
                <Reply />
              </Button>
              {(mine || isAdmin) && (
                <Button variant="ghost" size="icon-sm" aria-label="Delete message" className="text-muted-foreground" onClick={() => onDelete(m)}>
                  <Trash2 />
                </Button>
              )}
            </div>
          </div>
          {isSel && (
            <div
              role="toolbar"
              aria-label="Quick reactions"
              className={cn(
                'mt-1 flex max-w-[calc(100vw-5rem)] flex-wrap items-center gap-0.5 rounded-3xl border bg-popover p-1 shadow-md',
                mine ? 'self-end' : 'self-start',
              )}
            >
              {QUICK.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-label={`React ${e}`}
                  onClick={() => onReact(m, e)}
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-xl transition active:scale-90 hover:bg-muted"
                >
                  {e}
                </button>
              ))}
              <button
                type="button"
                aria-label="More reactions"
                onClick={() => onMore(m)}
                className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
              >
                <SmilePlus className="size-5" />
              </button>
              <button
                type="button"
                onClick={() => onReply(m)}
                className="ml-0.5 flex h-9 items-center gap-1 rounded-full px-3 text-sm font-medium hover:bg-muted"
              >
                <Reply className="size-4" /> Reply
              </button>
            </div>
          )}
          {!!m.reactions?.length && (
            <div className={cn('mt-1 flex flex-wrap gap-1', mine ? 'justify-end' : 'justify-start')}>
              {m.reactions.map((r) => {
                const me = r.subs.includes(mySub);
                const who = r.subs.map((s) => (s === mySub ? 'You' : (names.get(s) ?? 'Someone')));
                return (
                  <button
                    key={r.emoji}
                    type="button"
                    aria-pressed={me}
                    aria-label={`${r.emoji} ${r.subs.length}: ${who.join(', ')}`}
                    title={who.join(', ')}
                    onClick={() => onReact(m, r.emoji)}
                    className={cn(
                      'flex h-7 items-center gap-1 rounded-full border px-2 text-sm transition active:scale-95',
                      me ? 'border-primary/50 bg-primary/10' : 'bg-background hover:bg-muted',
                    )}
                  >
                    <span className="text-base leading-none">{r.emoji}</span>
                    <span className="tabular text-xs font-medium">{r.subs.length}</span>
                  </button>
                );
              })}
            </div>
          )}
          {isSel && grouped && <div className="mt-0.5 px-1 text-[11px] text-muted-foreground">{timeOf(m.createdAt)}</div>}
        </div>
      </div>,
    );
  });
  return <>{out}</>;
}

/** The quoted message at the top of a reply. Tap to jump to it. */
function Quote({ q, mine, mySub, onJump }: { q: NonNullable<ChatMessage['replyTo']>; mine: boolean; mySub: string; onJump: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!q.deleted) onJump(q.messageId);
      }}
      className={cn(
        'mx-2 mt-2 mb-0 block max-w-full rounded-lg border-l-[3px] px-2.5 py-1 text-left text-xs',
        mine ? 'border-primary-foreground/60 bg-primary-foreground/10' : 'border-brand/70 bg-background/60',
      )}
    >
      <div className="font-semibold">{q.sub === mySub ? 'You' : q.name}</div>
      <div className={cn('line-clamp-2', mine ? 'text-primary-foreground/80' : 'text-muted-foreground', q.deleted && 'italic')}>
        {q.deleted ? 'Deleted message' : (q.text ?? (q.image ? '📷 Photo' : ''))}
      </div>
    </button>
  );
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
      <img src={m.image!.url} alt={m.text ? '' : `Photo from ${m.name}`} loading="lazy" style={style} className="block object-cover" />
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

function Composer({
  onSent,
  replyTo,
  onCancelReply,
  mySub,
}: {
  onSent: (m: ChatMessage) => void;
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  mySub: string;
}) {
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
    if (t.length > MAX_TEXT) return void toast.error(`Messages can be up to ${MAX_TEXT.toLocaleString('en-US')} characters.`);
    setSending(true);
    try {
      let imageKey: string | undefined;
      if (att) imageKey = await api.chatUpload(att.blob);
      const r = await api.chatSend({ text: t || undefined, imageKey, width: att?.width, height: att?.height, replyTo: replyTo?.cursor });
      setText('');
      setAtt(null);
      onCancelReply();
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
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-[3px] border-brand/70 bg-muted/60 py-1.5 pr-1 pl-2.5 text-xs">
          <Reply className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Replying to {replyTo.sub === mySub ? 'yourself' : replyTo.name}</div>
            <div className="truncate text-muted-foreground">{replyTo.text ?? (replyTo.image ? '📷 Photo' : '')}</div>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Cancel reply" onClick={onCancelReply}>
            <X />
          </Button>
        </div>
      )}
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
          id="chat-composer"
          rows={1}
          value={text}
          maxLength={MAX_TEXT}
          placeholder="Message the club"
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && replyTo) onCancelReply();
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
        aria-label="Chat notifications"
        aria-pressed={on}
        disabled={busy}
        onClick={toggle}
        title={on ? 'Turn off chat notifications' : 'Get a notification for new messages'}
      >
        {busy ? <Spinner /> : on ? <Bell /> : <BellOff />}
        <span className="hidden sm:inline">{on ? 'Notifications on' : 'Notifications off'}</span>
        <span className="sm:hidden">{on ? 'On' : 'Off'}</span>
      </Button>
      <NotifyHelpDialog open={help} onClose={() => setHelp(false)} isAdmin={isAdmin} />
    </>
  );
}
