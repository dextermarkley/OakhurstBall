// Club notices: plain messages from the admins ("Gym closed for the next 3
// weeks"). No RSVP; each stays up until the last day the admin picks.
//   NoticesList      — player page: the notices showing today
//   NoticesAdminCard — admin: post / edit / take down
import { useCallback, useEffect, useState } from "react";
import { Info, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type Notice } from "@/api";
import { useConfirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ymdText } from "@/lib/format";
import { cn } from "@/lib/utils";

const MAX = 500;

/** Today at the club (Pacific), YYYY-MM-DD. */
const clubToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const untilText = (until: string) =>
  until === clubToday() ? "Today only" : `Until ${ymdText(until)}`;

function useNotices(pollMs: number) {
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const load = useCallback(
    () =>
      api
        .notices()
        .then((r) => setNotices(r.notices))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    load();
    const t = setInterval(
      () => document.visibilityState === "visible" && load(),
      pollMs,
    );
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load, pollMs]);
  return { notices, setNotices, load };
}

/** Player page. Renders nothing when there are no notices. */
export function NoticesList() {
  const { notices } = useNotices(60_000);
  if (!notices?.length) return null;
  return (
    <div className="space-y-3">
      {notices.map((n) => (
        <Card
          key={n.noticeId}
          size="sm"
          className="border-primary/20 bg-primary/[0.03]"
        >
          <CardContent className="flex items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Info className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-base leading-snug font-medium whitespace-pre-line">
                {n.text}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {n.createdByName} · {untilText(n.until)}
              </p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

const QUICK = [
  { label: "Today", days: 0 },
  { label: "1 week", days: 6 },
  { label: "2 weeks", days: 13 },
  { label: "3 weeks", days: 20 },
  { label: "1 month", days: 30 },
];

/** Compose or edit one notice. */
function NoticeForm({
  initial,
  onDone,
  onCancel,
}: {
  initial?: Notice;
  onDone: (n: Notice) => void;
  onCancel?: () => void;
}) {
  const today = clubToday();
  const [text, setText] = useState(initial?.text ?? "");
  const [until, setUntil] = useState(initial?.until ?? addDays(today, 6));
  const [notify, setNotify] = useState(!initial);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const r = initial
        ? await api.editNotice(initial.noticeId, text.trim(), until, notify)
        : await api.postNotice(text.trim(), until, notify);
      toast.success(
        (initial ? "Notice updated." : "Notice posted.") +
          (notify ? " Everyone with notifications on gets an alert." : ""),
      );
      if (!initial) setText("");
      onDone(r.notice);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        maxLength={MAX}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        placeholder="Gym closed for the next 3 weeks"
        aria-label="Notice"
        className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={`until-${initial?.noticeId ?? "new"}`}
          className="text-sm font-medium"
        >
          Show until
        </label>
        <Input
          id={`until-${initial?.noticeId ?? "new"}`}
          type="date"
          value={until}
          min={today}
          max={addDays(today, 180)}
          onChange={(e) => setUntil(e.target.value)}
          className="h-8 w-auto"
        />
        <div className="flex flex-wrap gap-1">
          {QUICK.map((q) => {
            const d = addDays(today, q.days);
            return (
              <button
                key={q.label}
                type="button"
                onClick={() => setUntil(d)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs",
                  until === d
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted",
                )}
              >
                {q.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="size-4 accent-[var(--primary)]"
          />
          {initial ? "Notify everyone about the change" : "Notify everyone"}
        </label>
        <span className="text-xs text-muted-foreground tabular">
          {text.length}/{MAX}
        </span>
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button disabled={busy || !text.trim() || !until} onClick={submit}>
          {busy ? <Spinner /> : initial ? null : <Plus />}{" "}
          {initial ? "Save" : "Post notice"}
        </Button>
      </div>
    </div>
  );
}

/** Admin: the notices that are up, plus a form to post another. */
export function NoticesAdminCard() {
  const confirm = useConfirm();
  const { notices, setNotices, load } = useNotices(30_000);
  const [editing, setEditing] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  async function remove(n: Notice) {
    const ok = await confirm({
      title: "Take down this notice?",
      description: "It disappears from player pages. Nobody is notified.",
      confirmLabel: "Take down",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.removeNotice(n.noticeId);
      setNotices((list) =>
        (list ?? []).filter((x) => x.noticeId !== n.noticeId),
      );
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  if (!notices) return null;
  const showForm = composing || notices.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Info className="size-4 text-primary" /> Club notices
        </CardTitle>
        <CardDescription>
          A message on everyone’s account page, like “Gym closed for the next 3
          weeks”. No RSVP. It comes down after the last day you pick.
        </CardDescription>
        {!showForm && notices.length < 5 && (
          <CardAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setComposing(true)}
            >
              <Plus /> New notice
            </Button>
          </CardAction>
        )}
      </CardHeader>
      {notices.length > 0 && (
        <CardContent className="space-y-3">
          {notices.map((n) =>
            editing === n.noticeId ? (
              <div key={n.noticeId} className="rounded-lg border p-3">
                <NoticeForm
                  initial={n}
                  onCancel={() => setEditing(null)}
                  onDone={(u) => {
                    setNotices((list) =>
                      (list ?? []).map((x) =>
                        x.noticeId === u.noticeId ? u : x,
                      ),
                    );
                    setEditing(null);
                    load();
                  }}
                />
              </div>
            ) : (
              <div
                key={n.noticeId}
                className="flex items-start gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium whitespace-pre-line">{n.text}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {n.createdByName} · {untilText(n.until)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Edit notice"
                    onClick={() => setEditing(n.noticeId)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Take down notice"
                    onClick={() => remove(n)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ),
          )}
        </CardContent>
      )}
      {showForm && (
        <CardFooter className="block">
          <NoticeForm
            onCancel={notices.length ? () => setComposing(false) : undefined}
            onDone={(n) => {
              setNotices((list) => [n, ...(list ?? [])]);
              setComposing(false);
            }}
          />
        </CardFooter>
      )}
    </Card>
  );
}
