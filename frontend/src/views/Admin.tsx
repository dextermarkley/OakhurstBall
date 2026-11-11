import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from 'recharts';
import {
  Banknote,
  CircleDollarSign,
  DoorClosed,
  DoorOpen,
  Inbox,
  MoreHorizontal,
  QrCode,
  Search,
  ShieldCheck,
  Gift,
  Tablet,
  Ticket,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  Users,
  ShieldOff,
  HandCoins,
} from 'lucide-react';
import { api, type AdminSession, type Attendee, type Plan, type PlanOffer } from '@/api';
import { AppShell, PageHeader } from '@/components/app-shell';
import { useConfirm } from '@/components/confirm';
import { FormInput } from '@/components/form-field';
import { StatCard } from '@/components/stat-card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { balanceText, dateOf, initials, longDateOf, money, planName, timeOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { normalizePhone, phoneText } from '@/lib/contact';
import { pairingUrl } from '@/pairing';
import { AuthGate } from './AuthGate';
import { StatusBadge } from './PlayerDashboard';
import { AnnounceAdminCard } from '@/components/announcement';
import { NoticesAdminCard } from '@/components/notices';
import { ExpensesTab } from './ExpensesTab';

export function Admin() {
  return <AuthGate>{(signOut) => <AdminInner signOut={signOut} />}</AuthGate>;
}

type TabId = 'overview' | 'sessions' | 'players' | 'payments' | 'expenses' | 'kiosks';

function AdminInner({ signOut }: { signOut: () => void }) {
  const [me, setMe] = useState<any>(null);
  const [error, setError] = useState('');
  // ?tab=players (e.g. from the "New sign-up" notification) opens that tab.
  const [tab, setTab] = useState<TabId>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return (['overview', 'sessions', 'players', 'payments', 'expenses', 'kiosks'] as const).includes(t as TabId)
      ? (t as TabId)
      : 'overview';
  });

  useEffect(() => {
    api.me().then(setMe).catch((e) => setError(e.message));
  }, []);

  const user = me ? { name: me.name ?? me.email, email: me.email, isAdmin: me.isAdmin } : { name: '' };

  if (error || (me && !me.isAdmin)) {
    return (
      <AppShell section="Admin" user={user} onSignOut={signOut}>
        <Empty className="mt-10 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheck />
            </EmptyMedia>
            <EmptyTitle>{error ? 'Something went wrong' : 'Admins only'}</EmptyTitle>
            <EmptyDescription>
              {error || "Your account isn’t in the admin group. Ask an organizer to add you."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/player" />}>Go to my player page</Button>
          </EmptyContent>
        </Empty>
      </AppShell>
    );
  }

  return (
    <AppShell section="Admin" user={user} onSignOut={signOut} wide>
      {!me ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
          <div className="-mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <TabsList variant="line" className="w-max">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
              <TabsTrigger value="players">Players</TabsTrigger>
              <TabsTrigger value="payments">Payments</TabsTrigger>
              <TabsTrigger value="expenses">Expenses</TabsTrigger>
              <TabsTrigger value="kiosks">Kiosks</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="overview">
            <OverviewTab onGo={setTab} />
          </TabsContent>
          <TabsContent value="sessions">
            <SessionsTab />
          </TabsContent>
          <TabsContent value="players">
            <PlayersTab />
          </TabsContent>
          <TabsContent value="payments">
            <PaymentsTab />
          </TabsContent>
          <TabsContent value="expenses">
            <ExpensesTab />
          </TabsContent>
          <TabsContent value="kiosks">
            <KiosksTab />
          </TabsContent>
        </Tabs>
      )}
    </AppShell>
  );
}

/* ───────────────────────────── Overview ───────────────────────────── */

const attendanceConfig = { players: { label: 'Players', color: 'var(--chart-1)' } } satisfies ChartConfig;
const mixConfig = {
  payg: { label: 'Pay as you go', color: 'var(--chart-4)' },
  quarter: { label: 'Quarter pass', color: 'var(--chart-1)' },
  year: { label: 'Year pass', color: 'var(--chart-2)' },
} satisfies ChartConfig;

function OverviewTab({ onGo }: { onGo: (t: TabId) => void }) {
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [players, setPlayers] = useState<any[] | null>(null);
  const [pending, setPending] = useState<any[] | null>(null);

  useEffect(() => {
    api.sessions().then((r) => setSessions(r.sessions)).catch((e) => toast.error(e.message));
    api.adminPlayers().then((r) => setPlayers(r.players)).catch((e) => toast.error(e.message));
    api.pending().then((r) => setPending(r.pending)).catch((e) => toast.error(e.message));
  }, []);

  const open = sessions?.find((s) => s.open);
  const attendance = useMemo(
    () =>
      (sessions ?? [])
        .slice(0, 12)
        .reverse()
        .map((s) => ({ day: new Date(s.openedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }), players: s.attendeeCount })),
    [sessions],
  );
  const mix = useMemo(() => {
    const ps = players ?? [];
    return [
      { key: 'payg', value: ps.filter((p) => !p.pass).length },
      { key: 'quarter', value: ps.filter((p) => p.pass?.plan === 'quarter').length },
      { key: 'year', value: ps.filter((p) => p.pass?.plan === 'year').length },
    ];
  }, [players]);
  const owing = (players ?? []).filter((p) => p.balanceCents < 0);
  const owedTotal = owing.reduce((s, p) => s - p.balanceCents, 0);
  const avg = sessions?.length
    ? (sessions.slice(0, 12).reduce((s, x) => s + x.attendeeCount, 0) / Math.min(12, sessions.length)).toFixed(1)
    : '0';

  if (!sessions || !players || !pending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="How the club is doing at a glance." />

      <AnnounceAdminCard />
      <NoticesAdminCard />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Gym"
          icon={open ? DoorOpen : DoorClosed}
          tone={open ? 'success' : 'default'}
          value={open ? 'Open' : 'Closed'}
          hint={open ? `${open.attendeeCount} in · until ${timeOf(open.closesAt)}` : 'Open a session on the Sessions tab'}
        />
        <StatCard label="Players" icon={Users} value={players.length} hint={`${players.filter((p) => p.pass).length} with a pass`} />
        <StatCard
          label="Owed to the club"
          icon={CircleDollarSign}
          tone={owedTotal ? 'danger' : 'default'}
          value={money(owedTotal)}
          hint={`${owing.length} player${owing.length === 1 ? '' : 's'} negative`}
        />
        <StatCard
          label="Pending payments"
          icon={Inbox}
          tone={pending.length ? 'brand' : 'default'}
          value={pending.length}
          hint={pending.length ? 'Waiting for confirmation' : 'All caught up'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Attendance</CardTitle>
            <CardDescription>
              {sessions.length
                ? `Players per session · last ${Math.min(12, sessions.length)} session${sessions.length === 1 ? '' : 's'} · avg ${avg}`
                : 'Players per session'}
            </CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" onClick={() => onGo('sessions')}>
                All sessions
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {attendance.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">No sessions yet.</p>
            ) : (
              <ChartContainer config={attendanceConfig} className="aspect-auto h-64 w-full">
                <BarChart data={attendance} margin={{ left: -16, right: 4, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                  <Bar dataKey="players" fill="var(--color-players)" radius={6} maxBarSize={44} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plans</CardTitle>
            <CardDescription>This period</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={mixConfig} className="mx-auto aspect-square h-48">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel />} />
                <Pie data={mix} dataKey="value" nameKey="key" innerRadius={52} outerRadius={80} strokeWidth={3}>
                  {mix.map((m) => (
                    <Cell key={m.key} fill={`var(--color-${m.key})`} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <div className="mt-4 space-y-2 text-sm">
              {mix.map((m) => (
                <div key={m.key} className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-sm" style={{ background: `var(--color-${m.key})` }} />
                    {mixConfig[m.key as keyof typeof mixConfig].label}
                  </span>
                  <span className="tabular font-medium">{m.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ───────────────────────────── Sessions ───────────────────────────── */

function SessionsTab() {
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [current, setCurrent] = useState<{ session: AdminSession; attendees: Attendee[] } | null>(null);
  const [viewing, setViewing] = useState<{ session: AdminSession; attendees?: Attendee[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [openFree, setOpenFree] = useState(false);

  async function toggleFree(s: AdminSession) {
    const paid = current?.attendees.filter((a) => a.feeCents > 0) ?? [];
    const ok = await confirm(
      s.free
        ? {
            title: 'End the free day?',
            description: 'Anyone who checks in from now on pays the usual fee. People who already checked in free stay free.',
            confirmLabel: 'End free day',
          }
        : {
            title: 'Make this a free day?',
            description:
              'Checking in costs nothing for the rest of this session, and the negative-balance limit doesn’t apply.' +
              (paid.length
                ? ` ${paid.length} player${paid.length === 1 ? '' : 's'} already paid ${money(paid.reduce((t, a) => t + a.feeCents, 0))} for today and will get it back.`
                : ''),
            confirmLabel: 'Make it free',
          },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.setFreeDay(s.sessionId, !s.free);
      toast.success(
        s.free
          ? 'Free day ended. Check-ins cost the usual fee again.'
          : `It’s a free day!${r.refunded ? ` Refunded ${money(r.refundedCents)} to ${r.refunded} player${r.refunded === 1 ? '' : 's'}.` : ''}`,
      );
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  // The newest page refreshes every 20 s; older pages are added by "Load older"
  // and kept across refreshes.
  const [older, setOlder] = useState<AdminSession[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadedOlder = useRef(false);
  async function loadMore() {
    if (!olderCursor) return;
    setLoadingMore(true);
    try {
      const r = await api.sessions(olderCursor);
      loadedOlder.current = true;
      setOlder((o) => [...o, ...r.sessions]);
      setOlderCursor(r.nextCursor);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoadingMore(false);
    }
  }
  const shown = useMemo(() => {
    const first = sessions ?? [];
    const seen = new Set(first.map((x) => x.sessionId));
    return [...first, ...older.filter((x) => !seen.has(x.sessionId))];
  }, [sessions, older]);

  const load = useCallback(async () => {
    try {
      const r = await api.sessions();
      setSessions(r.sessions);
      if (!loadedOlder.current) setOlderCursor(r.nextCursor);
      const open = r.sessions.find((s) => s.open);
      setCurrent(open ? await api.sessionDetail(open.sessionId) : null);
    } catch (e: any) {
      toast.error(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  async function openGym() {
    setBusy(true);
    try {
      await api.openSession(openFree);
      toast.success(openFree ? 'Free day! Session opened. Check-in costs nothing today.' : 'Session opened. Players can check in now.');
      setOpenFree(false);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function closeGym(id: string) {
    const ok = await confirm({
      title: 'Close this session?',
      description: 'Nobody else will be able to check in until a new session is opened.',
      confirmLabel: 'Close session',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.closeSession(id);
      toast.success('Session closed.');
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function view(s: AdminSession) {
    setViewing({ session: s });
    try {
      const r = await api.sessionDetail(s.sessionId);
      setViewing({ session: s, attendees: r.attendees });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Sessions" description="Open the gym so players can check in. Sessions close automatically after 5 hours." />

      <AnnounceAdminCard />
      <NoticesAdminCard />

      {sessions === null ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : current ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2.5">
              <span className="relative flex size-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2.5 rounded-full bg-success" />
              </span>
              Gym is open
              {current.session.free && (
                <Badge className="bg-success/12 text-success">
                  <Gift /> Free day
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Opened {timeOf(current.session.openedAt)} by {current.session.openedByName} · closes automatically at{' '}
              {timeOf(current.session.closesAt)}
            </CardDescription>
            <CardAction className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => toggleFree(current.session)}>
                <Gift /> {current.session.free ? 'End free day' : 'Make it a free day'}
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => closeGym(current.session.sessionId)}>
                <DoorClosed /> Close
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="mb-3 flex items-baseline gap-2">
              <span className="tabular text-3xl font-semibold">{current.attendees.length}</span>
              <span className="text-sm text-muted-foreground">checked in</span>
            </div>
            <AttendeeTable attendees={current.attendees} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="flex size-11 items-center justify-center rounded-full bg-muted">
                <DoorClosed className="size-5 text-muted-foreground" />
              </div>
              <div>
                <div className="font-semibold">The gym is closed</div>
                <div className="text-sm text-muted-foreground">Check-in is off at the kiosk and on player pages.</div>
              </div>
            </div>
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <Button size="lg" disabled={busy} onClick={openGym}>
                {busy ? <Spinner /> : openFree ? <Gift /> : <DoorOpen />} {openFree ? 'Open free day' : 'Open session'}
              </Button>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={openFree}
                  onChange={(e) => setOpenFree(e.target.checked)}
                  className="size-4 accent-[var(--primary)]"
                />
                Free day (no charge to check in)
              </label>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All sessions</CardTitle>
          <CardDescription>Select a session to see who attended.</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          {sessions && sessions.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No sessions yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead className="hidden sm:table-cell">Opened by</TableHead>
                  <TableHead className="text-right">Players</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((s) => (
                  <TableRow key={s.sessionId} className="cursor-pointer" onClick={() => view(s)}>
                    <TableCell className="font-medium">{longDateOf(s.openedAt)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {timeOf(s.openedAt)} – {s.open ? 'now' : s.endedAt ? timeOf(s.endedAt) : '—'}
                      {s.open && <Badge className="ml-2 bg-success/12 text-success">Open</Badge>}
                      {s.free && <Badge className="ml-2 bg-brand/12 text-brand">Free day</Badge>}
                      {s.autoClosed && <span className="ml-2 text-xs">auto-closed</span>}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{s.openedByName}</TableCell>
                    <TableCell className="tabular text-right font-medium">{s.attendeeCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {olderCursor && (
            <div className="mt-3 flex justify-center">
              <Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>
                {loadingMore && <Spinner />} Load older sessions
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <SheetContent className="w-full sm:max-w-md">
          {viewing && (
            <>
              <SheetHeader>
                <SheetTitle>{longDateOf(viewing.session.openedAt)}</SheetTitle>
                <SheetDescription>
                  {timeOf(viewing.session.openedAt)} –{' '}
                  {viewing.session.open ? 'now' : viewing.session.endedAt ? timeOf(viewing.session.endedAt) : '—'} · opened by{' '}
                  {viewing.session.openedByName}
                </SheetDescription>
              </SheetHeader>
              <div className="overflow-y-auto px-4 pb-6">
                {viewing.attendees ? (
                  <AttendeeTable attendees={viewing.attendees} />
                ) : (
                  <div className="space-y-2">
                    {[0, 1, 2].map((i) => (
                      <Skeleton key={i} className="h-10" />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AttendeeTable({ attendees }: { attendees: Attendee[] }) {
  if (attendees.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">Nobody checked in.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Player</TableHead>
          <TableHead>In at</TableHead>
          <TableHead className="text-right">Fee</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {attendees.map((a) => (
          <TableRow key={a.playerId}>
            <TableCell>
              <div className="flex items-center gap-2.5">
                <Avatar className="size-7">
                  <AvatarFallback className="text-[11px]">{initials(a.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="truncate font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">{a.source === 'player' ? 'Player page' : 'Kiosk'}</div>
                </div>
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground">{timeOf(a.at)}</TableCell>
            <TableCell className="tabular text-right">
              {a.coveredBy ? (
                <Badge variant="secondary">{planName(a.coveredBy)}</Badge>
              ) : a.freeDay ? (
                <Badge className="bg-success/12 text-success">Free day</Badge>
              ) : (
                money(a.feeCents)
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/* ───────────────────────────── Players ───────────────────────────── */

/** Admin → Players: tap a player for their contact details and statuses. */
function PlayerSheet({ p, versions, onClose }: { p: any | null; versions?: { waiver: string; rules: string }; onClose: () => void }) {
  const tel = (e164?: string) =>
    e164 ? (
      <a href={`tel:${e164}`} className="font-medium text-primary underline-offset-2 hover:underline">
        {phoneText(e164)}
      </a>
    ) : null;
  const missing = (what: string) => (
    <span className="text-muted-foreground">{p?.hasAccount ? `${what} not given yet (asked at next sign-in)` : 'Not given'}</span>
  );
  const current = p && p.waiverVersion === versions?.waiver && p.rulesVersion === versions?.rules;
  const Row = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
  return (
    <Sheet open={!!p} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md">
        {p && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2.5">
                <Avatar className="size-9">
                  <AvatarFallback className="text-xs">{initials(p.name)}</AvatarFallback>
                </Avatar>
                {p.name}
              </SheetTitle>
              <SheetDescription>{p.createdAt ? `Joined ${longDateOf(p.createdAt)}` : 'Player'}</SheetDescription>
            </SheetHeader>
            <div className="overflow-y-auto px-4 pb-6">
              <h3 className="mt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Contact</h3>
              <dl className="divide-y">
                <Row label="Email">
                  {p.email ? (
                    <a href={`mailto:${p.email}`} className="font-medium text-primary underline-offset-2 hover:underline">
                      {p.email}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </Row>
                <Row label="Phone">{tel(p.phone) ?? missing('Phone')}</Row>
                <Row label="Emergency contact">
                  {p.emergencyName || p.emergencyPhone ? (
                    <>
                      <div>{p.emergencyName ?? 'No name given'}</div>
                      {tel(p.emergencyPhone)}
                    </>
                  ) : (
                    missing('Emergency contact')
                  )}
                </Row>
              </dl>
              <h3 className="mt-5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Status</h3>
              <dl className="divide-y">
                <Row label="Account">{p.hasAccount ? 'Signed up in the app' : 'Added by an admin (kiosk only)'}</Row>
                <Row label="Admin">{p.isAdmin ? 'Yes' : 'No'}</Row>
                <Row label="Chat">
                  {!p.hasAccount ? (
                    <span className="text-muted-foreground">No account</span>
                  ) : p.isAdmin || p.approved ? (
                    'Approved'
                  ) : (
                    <span className="text-brand">Waiting for approval</span>
                  )}
                </Row>
                <Row label="Waiver + rules">
                  {current ? (
                    `Signed ${p.agreedAt ? longDateOf(p.agreedAt) : ''}`.trim()
                  ) : p.agreedAt ? (
                    <span className="text-brand">Older version, signed {longDateOf(p.agreedAt)}. Asked again at next check-in.</span>
                  ) : (
                    <span className="text-brand">Not signed. Asked at next check-in.</span>
                  )}
                </Row>
                <Row label="Plan">{p.pass ? `${planName(p.pass.plan)} · ${p.pass.label}` : 'Pay as you go'}</Row>
                <Row label="Balance">
                  <span className={cn('tabular font-medium', p.balanceCents < 0 && 'text-destructive')}>{balanceText(p.balanceCents)}</span>
                </Row>
              </dl>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

const optionalPhone = z.union([z.literal(''), z.string().trim().refine((v) => !!normalizePhone(v), 'Enter a phone number like (415) 555-0123')]);
const playerSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name'),
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email')]),
  phone: optionalPhone,
  emergencyName: z.string().trim().max(60),
  emergencyPhone: optionalPhone,
  pin: z.union([z.literal(''), z.string().regex(/^\d{4,6}$/, 'Use 4 to 6 digits')]),
});
const chargeSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount like 5 or 5.00')
    .refine((v) => Number(v) > 0 && Number(v) <= 1000, 'Between $0.01 and $1,000'),
});

function PlayersTab() {
  const confirm = useConfirm();
  const [players, setPlayers] = useState<any[] | null>(null);
  const [plans, setPlans] = useState<PlanOffer[]>([]);
  const [versions, setVersions] = useState<{ waiver: string; rules: string } | null>(null);
  const [q, setQ] = useState('');
  // Admins only (they're managed here: ⋯ → Make admin / Remove admin).
  const [onlyAdmins, setOnlyAdmins] = useState(() => new URLSearchParams(window.location.search).get('filter') === 'admins');
  const [adding, setAdding] = useState(false);
  const [charging, setCharging] = useState<any>(null);
  const [crediting, setCrediting] = useState<any>(null);
  const [viewing, setViewing] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.adminPlayers();
      setPlayers(r.players);
      setPlans(r.plans ?? []);
      setVersions(r.agreementVersions ?? null);
    } catch (e: any) {
      toast.error(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const shown = (players ?? []).filter(
    (p) => p.name.toLowerCase().includes(q.trim().toLowerCase()) && (!onlyAdmins || p.isAdmin),
  );
  const adminCount = (players ?? []).filter((p) => p.isAdmin).length;
  // Self sign-ups waiting for an admin (players added by an admin are approved already).
  const pending = (players ?? []).filter((p) => p.hasAccount && !p.approved && !p.isAdmin);

  async function setAdmin(p: any, admin: boolean) {
    const ok = await confirm(
      admin
        ? {
            title: `Make ${p.name} an admin?`,
            description:
              'They’ll be able to open and close the gym, confirm cash, charge and credit players, post announcements, and make or remove other admins. Players will also be able to hand them cash.',
            confirmLabel: 'Make admin',
          }
        : {
            title: `Remove ${p.name} as an admin?`,
            description:
              'They keep their player account, balance and chat access, but lose the Admin page right away and are signed out on their devices. Players can no longer pick them for cash.',
            confirmLabel: 'Remove admin',
            destructive: true,
          },
    );
    if (!ok) return;
    try {
      await api.setPlayerAdmin(p.playerId, admin);
      toast.success(admin ? `${p.name} is now an admin.` : `${p.name} is no longer an admin.`);
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function approve(p: any, approved: boolean) {
    if (!approved) {
      const ok = await confirm({
        title: `Remove ${p.name}’s chat access?`,
        description: 'They keep their account, balance and check-ins, but can’t open the chat until approved again.',
        confirmLabel: 'Remove access',
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      await api.approvePlayer(p.playerId, approved);
      toast.success(approved ? `${p.name} is approved. They can use the chat now.` : `${p.name} can no longer use the chat.`);
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function recordPass(p: any, plan: Plan) {
    const o = plans.find((x) => x.plan === plan)!;
    const ok = await confirm({
      title: `Record a ${planName(plan).toLowerCase()} for ${p.name}?`,
      description: `${money(o.priceCents)} · ${o.label}. Use this when they paid outside the app; their balance won’t change.` +
        (o.status === 'not_offered' ? ' This is outside the normal Apr 1 – Jun 30 sales window.' : ''),
      confirmLabel: 'Record pass',
    });
    if (!ok) return;
    try {
      const r = await api.grantPass(p.playerId, plan);
      toast.success(`${planName(plan)} recorded for ${p.name}` + (r.refundedCents ? ` · today’s ${money(r.refundedCents)} refunded` : ''));
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Players"
        description={players ? `${players.length} player${players.length === 1 ? '' : 's'}` : 'Loading…'}
        actions={
          <Button onClick={() => setAdding(true)}>
            <UserPlus /> Add player
          </Button>
        }
      />
      {pending.length > 0 && (
        <Card className="border-brand/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserCheck className="size-4 text-brand" /> {pending.length} new sign-up{pending.length === 1 ? '' : 's'} waiting for approval
            </CardTitle>
            <CardDescription>Approved members can see and post in the club chat. Everything else works without approval.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {pending.map((p) => (
              <div
                key={p.playerId}
                className="flex cursor-pointer flex-wrap items-center gap-3 rounded-lg border p-3 hover:bg-muted/40"
                onClick={() => setViewing(p)}
              >
                <Avatar className="size-8">
                  <AvatarFallback className="text-xs">{initials(p.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  {p.createdAt && <div className="truncate text-xs text-muted-foreground">Joined {longDateOf(p.createdAt)}</div>}
                </div>
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    approve(p, true);
                  }}
                >
                  <UserCheck /> Approve
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search players" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" aria-label="Search players" />
            </div>
            <div role="group" aria-label="Show" className="inline-flex rounded-lg border p-0.5 text-sm">
              {[
                [false, 'Everyone'],
                [true, `Admins${players ? ` (${adminCount})` : ''}`],
              ].map(([v, label]) => (
                <button
                  key={String(v)}
                  type="button"
                  aria-pressed={onlyAdmins === v}
                  onClick={() => setOnlyAdmins(v as boolean)}
                  className={cn('rounded-md px-3 py-1', onlyAdmins === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
                >
                  {label as string}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          {players === null ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{onlyAdmins && !q.trim() ? 'No admins yet.' : 'No players found.'}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Plan</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((p) => (
                  <TableRow key={p.playerId} className="cursor-pointer" onClick={() => setViewing(p)}>
                    {/* Wraps on a phone, so Plan and Balance stay on screen. */}
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <Avatar className="size-8">
                          <AvatarFallback className="text-xs">{initials(p.name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{p.name}</span>
                          {/* On phones the Plan column is hidden, so say it here. */}
                          {p.pass && <div className="text-xs text-success sm:hidden">{planName(p.pass.plan)}</div>}
                        </div>
                        {!(p.waiverVersion === versions?.waiver && p.rulesVersion === versions?.rules) && (
                          <Badge
                            variant="outline"
                            className="border-brand/40 text-brand"
                            title={p.agreedAt ? 'Signed an older version. Asked to sign again at next check-in.' : 'Hasn’t signed yet. Asked to sign at next check-in.'}
                          >
                            {p.agreedAt ? 'Waiver outdated' : 'No waiver'}
                          </Badge>
                        )}
                        {p.isAdmin && (
                          <Badge variant="outline" className="border-primary/40 text-primary">
                            <ShieldCheck /> Admin
                          </Badge>
                        )}
                        {p.hasAccount && !p.approved && !p.isAdmin && (
                          <Badge variant="outline" className="text-muted-foreground" title="Can’t use the chat until approved">
                            Not approved
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {p.pass ? (
                        <Badge variant="secondary" title={p.pass.label}>
                          <Ticket /> {planName(p.pass.plan)}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">Pay as you go</span>
                      )}
                    </TableCell>
                    <TableCell className={cn('tabular text-right font-medium', p.balanceCents < 0 && 'text-destructive')}>
                      {balanceText(p.balanceCents)}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.name}`}>
                              <MoreHorizontal />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end" className="w-60">
                          <DropdownMenuItem onClick={() => setCharging(p)}>
                            <Banknote /> Charge…
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setCrediting(p)}>
                            <HandCoins /> {p.balanceCents < 0 ? 'Clear debt / credit…' : 'Credit…'}
                          </DropdownMenuItem>
                          {p.isAdmin ? (
                            !p.isMe && (
                              <DropdownMenuItem onClick={() => setAdmin(p, false)}>
                                <ShieldOff /> Remove admin
                              </DropdownMenuItem>
                            )
                          ) : p.hasAccount ? (
                            <DropdownMenuItem onClick={() => setAdmin(p, true)}>
                              <ShieldCheck /> Make admin
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem disabled>
                              <ShieldCheck /> Make admin
                              <span className="ml-auto text-xs text-muted-foreground">needs an account</span>
                            </DropdownMenuItem>
                          )}
                          {p.hasAccount &&
                            !p.isAdmin &&
                            (p.approved ? (
                              <DropdownMenuItem onClick={() => approve(p, false)}>
                                <UserX /> Remove chat access
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => approve(p, true)}>
                                <UserCheck /> Approve for chat
                              </DropdownMenuItem>
                            ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>Record a pass paid outside the app</DropdownMenuLabel>
                            {plans.map((o) => {
                              const owned = p.pass?.plan === 'year' || (o.plan === 'quarter' && p.pass?.plan === 'quarter');
                              return (
                                <DropdownMenuItem key={o.plan} disabled={owned} onClick={() => recordPass(p, o.plan)}>
                                  <Ticket /> {planName(o.plan)} · {money(o.priceCents)}
                                  {o.status === 'not_offered' && <span className="ml-auto text-xs text-muted-foreground">usually sold Apr 1 – Jun 30</span>}
                                </DropdownMenuItem>
                              );
                            })}
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AddPlayerDialog open={adding} onOpenChange={setAdding} onDone={load} />
      <ChargeDialog player={charging} onClose={() => setCharging(null)} onDone={load} />
      <CreditDialog player={crediting} onClose={() => setCrediting(null)} onDone={load} />
      <PlayerSheet p={viewing} versions={versions ?? undefined} onClose={() => setViewing(null)} />
    </div>
  );
}

function AddPlayerDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const form = useForm<z.infer<typeof playerSchema>>({
    resolver: zodResolver(playerSchema),
    defaultValues: { name: '', email: '', pin: '', phone: '', emergencyName: '', emergencyPhone: '' },
  });
  const submit = form.handleSubmit(async (v) => {
    try {
      await api.createPlayer({
        name: v.name,
        email: v.email || undefined,
        pin: v.pin || undefined,
        phone: v.phone || undefined,
        emergencyName: v.emergencyName || undefined,
        emergencyPhone: v.emergencyPhone || undefined,
      });
      toast.success(`${v.name} added.`);
      form.reset();
      onOpenChange(false);
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Add player</DialogTitle>
            <DialogDescription>For players without an account. People who sign up themselves are added automatically.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-5">
            <FormInput control={form.control} name="name" label="Name" autoComplete="off" />
            <FormInput control={form.control} name="email" label="Email (optional)" type="email" autoComplete="off" />
            <FormInput control={form.control} name="phone" label="Phone (optional)" type="tel" inputMode="tel" autoComplete="off" />
            <FormInput control={form.control} name="emergencyName" label="Emergency contact (optional)" autoComplete="off" />
            <FormInput control={form.control} name="emergencyPhone" label="Emergency contact’s phone (optional)" type="tel" inputMode="tel" autoComplete="off" />
            <FormInput
              control={form.control}
              name="pin"
              label="Kiosk PIN (optional)"
              inputMode="numeric"
              maxLength={6}
              description="4 to 6 digits. Tell the player; they can’t see it again. They can set their own if they sign up later. Without a PIN they can’t check in at the kiosk."
            />
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />} Add player
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const creditSchema = chargeSchema.extend({
  reason: z.string().trim().min(2, 'Say why, e.g. “Forgave unpaid sessions”').max(200),
});
const CREDIT_REASONS = ['Forgave unpaid sessions', 'Paid outside the app', 'Refund', 'Correction'];

/**
 * Add money to a player's balance without a payment: e.g. clear a debt they
 * won't pay. Saved with the reason and who did it (ADJUST# audit row); it is not
 * counted as income.
 */
function CreditDialog({ player, onClose, onDone }: { player: any; onClose: () => void; onDone: () => void }) {
  const owes = player && player.balanceCents < 0 ? -player.balanceCents : 0;
  const form = useForm<z.infer<typeof creditSchema>>({ resolver: zodResolver(creditSchema), defaultValues: { amount: '', reason: '' } });
  useEffect(() => {
    if (player) form.reset({ amount: owes ? (owes / 100).toFixed(2) : '', reason: owes ? 'Forgave unpaid sessions' : '' });
  }, [player]); // eslint-disable-line react-hooks/exhaustive-deps
  const cents = Math.round(Number(form.watch('amount')) * 100) || 0;
  const reason = form.watch('reason');
  const submit = form.handleSubmit(async (v) => {
    const c = Math.round(Number(v.amount) * 100);
    try {
      const r = await api.credit(player.playerId, c, v.reason);
      toast.success(`Credited ${player.name} ${money(c)}. Balance is now ${balanceText(r.balanceCents)}.`);
      onClose();
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    }
  });
  return (
    <Dialog open={!!player} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{owes ? `Clear ${player?.name}’s debt` : `Credit ${player?.name}`}</DialogTitle>
            <DialogDescription>
              Adds to their balance with no payment, and isn’t counted as income. Balance: {player && balanceText(player.balanceCents)}.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-5">
            <div>
              <FormInput control={form.control} name="amount" label="Amount (USD)" inputMode="decimal" placeholder="5.00" autoComplete="off" />
              {owes > 0 && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="rounded-full border px-2.5 py-0.5 text-xs hover:bg-muted"
                    onClick={() => form.setValue('amount', (owes / 100).toFixed(2), { shouldValidate: true })}
                  >
                    Clear it all · {money(owes)}
                  </button>
                </div>
              )}
            </div>
            <div>
              <FormInput control={form.control} name="reason" label="Reason" placeholder="Forgave unpaid sessions" autoComplete="off" maxLength={200} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {CREDIT_REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => form.setValue('reason', r, { shouldValidate: true })}
                    className={cn('rounded-full border px-2.5 py-0.5 text-xs', reason === r ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            {player && cents > 0 && (
              <p className="text-sm text-muted-foreground">
                New balance: <span className="font-medium text-foreground">{balanceText(player.balanceCents + cents)}</span>
              </p>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />} {owes ? 'Clear debt' : 'Add credit'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChargeDialog({ player, onClose, onDone }: { player: any; onClose: () => void; onDone: () => void }) {
  const form = useForm<z.infer<typeof chargeSchema>>({ resolver: zodResolver(chargeSchema), defaultValues: { amount: '' } });
  const chargeCents = Math.round(Number(form.watch('amount')) * 100);
  const overLimit = !!player && chargeCents > 0 && player.balanceCents - chargeCents < -1000;
  useEffect(() => {
    if (player) form.reset({ amount: '' });
  }, [player, form]);
  const submit = form.handleSubmit(async (v) => {
    try {
      await api.charge(player.playerId, Math.round(Number(v.amount) * 100), 'admin charge');
      toast.success(`Charged ${player.name} ${money(Math.round(Number(v.amount) * 100))}.`);
      onClose();
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    }
  });
  return (
    <Dialog open={!!player} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Charge {player?.name}</DialogTitle>
            <DialogDescription>Takes the amount from their balance. Balance: {player && balanceText(player.balanceCents)}.{overLimit && ' This will take their balance below the −$10 limit.'}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-5">
            <FormInput control={form.control} name="amount" label="Amount (USD)" inputMode="decimal" placeholder="5.00" autoComplete="off" />
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />} Charge
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────────── Payments ───────────────────────────── */

function PaymentsTab() {
  const confirm = useConfirm();
  const [pending, setPending] = useState<any[] | null>(null);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      setPending((await api.pending()).pending);
    } catch (e: any) {
      toast.error(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function settle(p: any, action: 'confirm' | 'deny') {
    const ok = await confirm({
      title: action === 'confirm' ? `Confirm ${money(p.amountCents)} from ${p.playerName}?` : `Deny ${p.playerName}’s payment?`,
      description:
        action === 'confirm'
          ? p.plan
            ? `This activates their ${planName(p.plan).toLowerCase()} (${p.periodLabel}).`
            : 'This adds the amount to their balance.'
          : 'Nothing is credited. Use this if the cash was never handed over.',
      confirmLabel: action === 'confirm' ? 'Confirm payment' : 'Deny payment',
      destructive: action === 'deny',
    });
    if (!ok) return;
    setBusyId(p.paymentId);
    try {
      await api.settlePayment(p.paymentId, action);
      toast.success(action === 'confirm' ? 'Payment confirmed.' : 'Payment denied.');
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Cash waits for an admin to confirm, from the notification or here. Card payments confirm automatically."
        actions={
          <Button variant="outline" onClick={load}>
            Refresh
          </Button>
        }
      />
      <Card>
        <CardContent>
          {pending === null ? (
            <Skeleton className="h-24" />
          ) : pending.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>All caught up</EmptyTitle>
                <EmptyDescription>No payments are waiting for confirmation.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Player</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead className="hidden md:table-cell">When</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((p) => (
                  <TableRow key={p.paymentId}>
                    <TableCell className="font-medium">{p.playerName}</TableCell>
                    <TableCell>
                      <div>{p.plan ? planName(p.plan) : 'Credit'}</div>
                      <div className="text-xs text-muted-foreground capitalize">
                        {p.method}
                        {p.adminName ? ` · to ${p.adminName}` : ''}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {dateOf(p.createdAt)}, {timeOf(p.createdAt)}
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">{money(p.amountCents)}</TableCell>
                    <TableCell className="text-right">
                      {p.method === 'cash' ? (
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="outline" disabled={busyId === p.paymentId} onClick={() => settle(p, 'deny')}>
                            Deny
                          </Button>
                          <Button size="sm" disabled={busyId === p.paymentId} onClick={() => settle(p, 'confirm')}>
                            Confirm
                          </Button>
                        </div>
                      ) : (
                        <StatusBadge status="pending" />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ───────────────────────────── Kiosks ───────────────────────────── */

const kioskSchema = z.object({
  deviceId: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/, 'Letters, digits, - or _ (e.g. court-kiosk-1)'),
  label: z.string().trim().max(60),
});

function KiosksTab() {
  const [kiosks, setKiosks] = useState<any[] | null>(null);
  const [pairing, setPairing] = useState(false);
  const [generated, setGenerated] = useState<{ deviceId: string; label: string; token: string; qr: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setKiosks((await api.kiosks()).kiosks);
    } catch (e: any) {
      toast.error(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const confirm = useConfirm();
  const [removing, setRemoving] = useState<string | null>(null);
  async function removeKiosk(k: { deviceId: string; label: string }) {
    const ok = await confirm({
      title: `Remove ${k.label || k.deviceId}?`,
      description: 'It stops working right away and goes back to its pairing screen. You can pair it again later with a new QR code.',
      confirmLabel: 'Remove kiosk',
      destructive: true,
    });
    if (!ok) return;
    setRemoving(k.deviceId);
    try {
      await api.deleteKiosk(k.deviceId);
      toast.success(`${k.label || k.deviceId} removed.`);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRemoving(null);
    }
  }

  const form = useForm<z.infer<typeof kioskSchema>>({ resolver: zodResolver(kioskSchema), defaultValues: { deviceId: '', label: '' } });
  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await api.createKiosk(v.deviceId, v.label || undefined);
      const qr = await QRCode.toDataURL(pairingUrl(r.deviceId, r.token), { width: 320, margin: 1 });
      setGenerated({ ...r, qr });
      form.reset();
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  });

  const close = () => {
    setPairing(false);
    setGenerated(null);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Kiosks"
        description="Pair a kiosk by scanning a QR code."
        actions={
          <Button onClick={() => setPairing(true)}>
            <QrCode /> Pair a kiosk
          </Button>
        }
      />
      <Card>
        <CardContent>
          {kiosks === null ? (
            <Skeleton className="h-24" />
          ) : kiosks.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Tablet />
                </EmptyMedia>
                <EmptyTitle>No kiosks paired</EmptyTitle>
                <EmptyDescription>Pair a kiosk to start checking players in.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kiosk</TableHead>
                  <TableHead>Device ID</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">Remove</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kiosks.map((k) => (
                  <TableRow key={k.deviceId}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        <Tablet className="size-4 text-muted-foreground" /> {k.label || k.deviceId}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{k.deviceId}</TableCell>
                    <TableCell className="text-right">
                      <Badge className={k.active ? 'bg-success/12 text-success' : 'bg-muted text-muted-foreground'}>
                        {k.active ? 'Active' : 'Disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${k.label || k.deviceId}`}
                        disabled={removing === k.deviceId}
                        onClick={() => removeKiosk(k)}
                      >
                        {removing === k.deviceId ? <Spinner /> : <Trash2 />}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={pairing} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-md">
          {generated ? (
            <>
              <DialogHeader>
                <DialogTitle>Scan with the kiosk</DialogTitle>
                <DialogDescription>
                  On the kiosk screen tap <span className="font-medium text-foreground">Scan pairing QR</span>, or point the kiosk’s
                  Camera app at the code.
                </DialogDescription>
              </DialogHeader>
              <div className="flex justify-center py-4">
                <img src={generated.qr} alt="Kiosk pairing QR code" className="size-64 rounded-lg border p-2" />
              </div>
              <p className="text-center text-xs text-muted-foreground">
                Shown once. Anyone who scans it can act as a kiosk, so close it once the kiosk is paired.
              </p>
              <details className="mt-2 rounded-lg border p-3 text-sm">
                <summary className="cursor-pointer text-muted-foreground">Enter the code by hand instead</summary>
                <div className="mt-3 space-y-2">
                  <div>
                    <div className="text-xs text-muted-foreground">Device ID</div>
                    <code className="text-xs">{generated.deviceId}</code>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Token</div>
                    <code className="text-xs break-all">{generated.token}</code>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigator.clipboard?.writeText(generated.token).then(() => toast.success('Token copied'))}
                  >
                    Copy token
                  </Button>
                </div>
              </details>
              <DialogFooter>
                <Button onClick={close}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={submit} noValidate>
              <DialogHeader>
                <DialogTitle>Pair a kiosk</DialogTitle>
                <DialogDescription>Reusing an existing device ID replaces its code and un-pairs that kiosk.</DialogDescription>
              </DialogHeader>
              <FieldGroup className="py-5">
                <FormInput control={form.control} name="deviceId" label="Device ID" placeholder="court-kiosk-1" autoComplete="off" />
                <FormInput control={form.control} name="label" label="Label (optional)" placeholder="Main entrance" autoComplete="off" />
              </FieldGroup>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting && <Spinner />} Generate QR code
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
