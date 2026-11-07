// Today's session announcement ("Ball today OCI - 5:30") with RSVPs.
//   AnnouncementCard — player page: read it, RSVP, see who's coming
//   AnnounceAdminCard — admin Sessions tab: post / edit / take down
import { useCallback, useEffect, useState } from 'react';
import { Check, Megaphone, Pencil, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Rsvp, type RsvpStatus } from '@/api';
import { useConfirm } from '@/components/confirm';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { initials, timeOf } from '@/lib/format';
import { cn } from '@/lib/utils';

function useAnnouncement(pollMs: number) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.announcement>> | null>(null);
  const load = useCallback(() => api.announcement().then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), pollMs);
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load, pollMs]);
  return { data, setData, load };
}

/** Player page card. Renders nothing when there's no announcement today. */
export function AnnouncementCard() {
  const { data, setData } = useAnnouncement(30_000);
  const [busy, setBusy] = useState<RsvpStatus | 'clear' | null>(null);
  const a = data?.announcement;
  if (!a) return null;
  const mine = a.rsvps.find((r) => r.playerId === data?.myPlayerId)?.status ?? null;

  async function rsvp(status: RsvpStatus) {
    if (!a) return;
    const next = mine === status ? null : status; // tap again to undo
    setBusy(next ?? 'clear');
    try {
      const r = await api.rsvp(a.announceId, next);
      setData((d) => (d ? { ...d, announcement: r.announcement } : d));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="border-brand/30 bg-brand/[0.04]">
      <CardHeader>
        <CardTitle className="flex items-start gap-3 text-lg">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand">
            <Megaphone className="size-4" />
          </span>
          <span className="leading-snug">{a.text}</span>
        </CardTitle>
        <CardDescription className="pl-11">
          {a.createdByName} · {timeOf(a.updatedAt)}
          {a.updatedAt !== a.createdAt && ' (edited)'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pl-[3.75rem]">
        <div className="flex flex-wrap gap-2">
          <Button
            variant={mine === 'in' ? 'default' : 'outline'}
            className={cn(mine === 'in' && 'bg-success text-white hover:bg-success/90')}
            disabled={!!busy || !data?.myPlayerId}
            onClick={() => rsvp('in')}
            aria-pressed={mine === 'in'}
          >
            {busy === 'in' ? <Spinner /> : <Check />} I'm in
          </Button>
          <Button
            variant={mine === 'out' ? 'secondary' : 'outline'}
            disabled={!!busy || !data?.myPlayerId}
            onClick={() => rsvp('out')}
            aria-pressed={mine === 'out'}
          >
            {busy === 'out' ? <Spinner /> : <X />} Can't make it
          </Button>
        </div>
        <RsvpLists rsvps={a.rsvps} />
      </CardContent>
    </Card>
  );
}

export function RsvpLists({ rsvps }: { rsvps: Rsvp[] }) {
  const ins = rsvps.filter((r) => r.status === 'in');
  const outs = rsvps.filter((r) => r.status === 'out');
  if (!rsvps.length) return <p className="text-sm text-muted-foreground">No RSVPs yet. Be the first.</p>;
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-2 text-sm font-medium">
          <span className="tabular">{ins.length}</span> in
        </div>
        {ins.length ? (
          <div className="flex flex-wrap gap-1.5">
            {ins.map((r) => (
              <span key={r.playerId} className="inline-flex items-center gap-1.5 rounded-full border bg-background py-0.5 pr-2.5 pl-0.5 text-sm">
                <Avatar className="size-6">
                  <AvatarFallback className="bg-success/15 text-[10px] font-medium text-success">{initials(r.name)}</AvatarFallback>
                </Avatar>
                {r.name}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Nobody yet.</p>
        )}
      </div>
      {outs.length > 0 && (
        <div className="text-sm text-muted-foreground">
          <span className="font-medium">Can't make it:</span> {outs.map((r) => r.name).join(', ')}
        </div>
      )}
    </div>
  );
}

/** Admin: compose today's announcement, or manage the one that's up. */
export function AnnounceAdminCard() {
  const confirm = useConfirm();
  const { data, setData, load } = useAnnouncement(20_000);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const a = data?.announcement ?? null;

  // Prefill with the usual text the first time we know it.
  useEffect(() => {
    if (data && !text && !editing) setText(data.defaultText);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function post() {
    setBusy(true);
    try {
      const r = await api.postAnnouncement(text.trim());
      setData((d) => (d ? { ...d, announcement: r.announcement } : d));
      toast.success('Announced. Everyone with notifications on was notified.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!a) return;
    setBusy(true);
    try {
      const r = await api.editAnnouncement(a.announceId, text.trim(), notify);
      setData((d) => (d ? { ...d, announcement: r.announcement } : d));
      setEditing(false);
      toast.success(notify ? 'Updated, and everyone was notified.' : 'Updated.');
    } catch (e: any) {
      toast.error(e.message);
      load();
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!a) return;
    const ok = await confirm({
      title: 'Take down this announcement?',
      description: 'It disappears from player pages and its RSVPs are cleared. Nobody is notified.',
      confirmLabel: 'Take down',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.removeAnnouncement(a.announceId);
      setData((d) => (d ? { ...d, announcement: null } : d));
      setText(data?.defaultText ?? '');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const tooLong = text.trim().length > 280;
  const field = (
    <Input
      id="announcement-text"
      value={text}
      maxLength={280}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && text.trim() && !busy && (a ? save() : post())}
      aria-label="Announcement"
      className="h-10 text-base"
    />
  );

  if (!data) return null;

  if (!a || editing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="size-4 text-brand" /> {a ? 'Edit announcement' : 'Announce today’s session'}
          </CardTitle>
          <CardDescription>
            {a
              ? 'RSVPs are kept.'
              : 'Shows on everyone’s player page with RSVP buttons, and notifies everyone who has notifications on. It disappears at midnight.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {field}
          {a && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="size-4 accent-[var(--primary)]" />
              Notify everyone about the change
            </label>
          )}
          {tooLong && <p className="text-sm text-destructive">Keep it under 280 characters.</p>}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          {a && (
            <Button variant="outline" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
          <Button disabled={busy || !text.trim() || tooLong} onClick={a ? save : post}>
            {busy ? <Spinner /> : <Megaphone />} {a ? 'Save' : 'Post announcement'}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="border-brand/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Megaphone className="size-4 text-brand" /> {a.text}
        </CardTitle>
        <CardDescription>
          Announced {timeOf(a.createdAt)} by {a.createdByName}
          {a.updatedAt !== a.createdAt && ` · edited ${timeOf(a.updatedAt)}`}
        </CardDescription>
        <CardAction className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit announcement"
            onClick={() => {
              setText(a.text);
              setNotify(true);
              setEditing(true);
            }}
          >
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Take down announcement" disabled={busy} onClick={remove}>
            <Trash2 />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="pt-1">
        <RsvpLists rsvps={a.rsvps} />
      </CardContent>
    </Card>
  );
}
