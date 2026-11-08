// The signed-in player's own page: gym session + check-in, plan, balance,
// attendance chart, kiosk PIN, and history. Also shown in Admin → "My account".
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import {
  CalendarCheck,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  CreditCard,
  Gift,
  KeyRound,
  Lock,
  Ticket,
  Users,
} from 'lucide-react';
import { api, type CheckinResult, type MySession, type Plan, type PlanOffer } from '@/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormInput } from '@/components/form-field';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { balanceText, dateOf, money, planName, timeOf, ymdText } from '@/lib/format';
import { PayDialog } from './PayDialog';
import { AnnouncementCard } from '@/components/announcement';
import { NoticesList } from '@/components/notices';
import { cn } from '@/lib/utils';

export function PlayerDashboard() {
  const [data, setData] = useState<any>(null);
  const [session, setSession] = useState<MySession | null>(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(false);

  async function load() {
    try {
      const [d, s] = await Promise.all([api.myBalance(), api.mySession()]);
      setData(d);
      setSession(s);
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(() => api.mySession().then(setSession).catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, []);

  if (error) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>We couldn’t load your account</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
          <Button
            className="mt-2"
            onClick={() => {
              setError('');
              load();
            }}
          >
            Try again
          </Button>
        </EmptyHeader>
      </Empty>
    );
  }
  if (!data || !session) return <DashboardSkeleton />;

  const firstName = String(data.name ?? '').split(' ')[0] || 'there';
  const fee = session.feeCents || 500;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hi, {firstName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Here’s your Oakhurst Basketball account.</p>
        </div>
        <Button onClick={() => setPaying(true)}>
          <CreditCard /> Pay now
        </Button>
      </div>
      <PayDialog open={paying} onClose={() => setPaying(false)} s={session} onChanged={load} />

      <NoticesList />
      <AnnouncementCard />

      <SessionCard s={session} onChange={load} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1">
        <StatCard
          label="Balance"
          icon={CircleDollarSign}
          tone={data.balanceCents < 0 ? 'danger' : 'success'}
          value={<span className={cn(data.balanceCents < 0 && 'text-destructive')}>{balanceText(data.balanceCents)}</span>}
          hint={data.balanceCents < 0 ? 'Owed to the club' : data.balanceCents === 0 ? 'Add credit to pay as you go' : 'Covers pay-as-you-go sessions'}
        />
        <StatCard
          label="Plan"
          icon={Ticket}
          tone="brand"
          value={session.pass ? planName(session.pass.plan) : 'Pay as you go'}
          hint={session.pass ? `Through ${ymdText(session.pass.end)}` : `${money(fee)} per session`}
        />
        <StatCard
          label="Check-ins"
          icon={CalendarCheck}
          value={data.checkinCount ?? data.checkins.length}
          hint={data.checkins[0] ? `All time · last ${dateOf(data.checkins[0].at)}` : 'No check-ins yet'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <PlanCard s={session} className="lg:col-span-2" onBuy={() => setPaying(true)} />
        <AttendanceChart byMonth={data.checkinsByMonth ?? {}} className="lg:col-span-3" />
      </div>

      <HistoryCard
        checkins={data.checkins}
        payments={data.payments}
        checkinsCursor={data.checkinsCursor ?? null}
        paymentsCursor={data.paymentsCursor ?? null}
      />
      <PinCard />
    </div>
  );
}

function SessionCard({ s, onChange }: { s: MySession; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  // Set when check-in needs a payment decision first (needs_payment or limit).
  const [ask, setAsk] = useState<CheckinResult | null>(null);

  function report(r: CheckinResult) {
    if (r.result === 'needs_agreement') {
      // The waiver or rules changed while this page was open: reload to sign them.
      toast.info('Please sign the updated waiver and Club Rules first.');
      setTimeout(() => window.location.reload(), 1200);
      return;
    }
    if (r.result === 'no_session') toast.error('The gym just closed.');
    else if (r.result === 'already') toast.info('You’re already checked in.');
    else if (r.result !== 'checked_in') {
      // Never claim success for a reply we don't understand (e.g. an older app version).
      toast.error('Couldn’t check you in. Refresh the page and try again.');
      return;
    } else
      toast.success(
        r.pass
          ? 'Checked in. Covered by your pass.'
          : r.freeDay
            ? 'Checked in. It’s a free day, so no charge today.'
            : (r.balanceCents ?? 0) < 0
              ? `Checked in. Balance ${balanceText(r.balanceCents ?? 0)}.`
              : r.feeCents === undefined
                ? 'Checked in.'
                : `Checked in. ${money(r.feeCents)} from your credit.`,
      );
  }

  async function checkIn() {
    setBusy(true);
    try {
      const r = await api.myCheckin('auto');
      if (r.result === 'needs_payment' || r.result === 'limit') setAsk(r);
      else {
        report(r);
        onChange();
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!s.session) {
    return (
      <Card className="border-dashed bg-transparent shadow-none ring-0">
        <CardContent className="flex items-center gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
            <Lock className="size-4.5 text-muted-foreground" />
          </div>
          <div>
            <div className="font-medium">The gym is closed</div>
            <div className="text-sm text-muted-foreground">You can check in here once an admin opens a session.</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden bg-primary text-primary-foreground ring-0">
      <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <span className="relative mt-1.5 flex size-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2.5 rounded-full bg-success" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              The gym is open
              {s.session.free && (
                <Badge className="bg-success text-white">
                  <Gift /> Free day
                </Badge>
              )}
            </div>
            {s.session.free && <div className="mt-0.5 text-sm text-primary-foreground/90">No charge to play today.</div>}
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-primary-foreground/70">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="size-3.5" /> Until {timeOf(s.session.closesAt)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Users className="size-3.5" /> {s.session.attendeeCount} checked in
              </span>
            </div>
          </div>
        </div>
        {s.checkedIn ? (
          <Badge className="h-9 gap-1.5 bg-success px-3 text-sm text-white">
            <CheckCircle2 className="size-4" /> You’re checked in
          </Badge>
        ) : (
          <div className="flex flex-col gap-2 sm:items-end">
            <Button size="lg" className="h-11 bg-brand px-5 text-base text-brand-foreground hover:bg-brand/90" disabled={busy} onClick={checkIn}>
              {busy && !ask && <Spinner />}
              {s.payState === 'covered'
                ? 'Check in · covered by pass'
                : s.payState === 'free'
                  ? 'Check in · free today'
                  : s.payState === 'blocked'
                    ? 'Pay to check in'
                    : 'Check in'}
            </Button>
            {s.payState === 'blocked' && (
              <div className="text-sm text-primary-foreground/80">Your balance is {balanceText(s.balanceCents)}. Add credit to keep playing.</div>
            )}
          </div>
        )}
      </CardContent>

      <PayDialog open={!!ask} onClose={() => setAsk(null)} s={s} ask={ask} onChanged={onChange} />
    </Card>
  );
}

function PlanCard({ s, className, onBuy }: { s: MySession; className?: string; onBuy: () => void }) {
  const offers = s.options.plans.filter((o) => o.status !== 'not_offered');
  const fee = s.feeCents || 500;
  const yearListed = offers.some((o) => o.plan === 'year');

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Your plan</CardTitle>
        <CardDescription>
          {s.pass ? `${planName(s.pass.plan)} · ${s.pass.label}` : `Pay as you go · ${money(fee)} per session`}
        </CardDescription>
        {s.pass && (
          <CardAction>
            <Badge className="bg-success/12 text-success">Active</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {offers.length === 0 && <p className="text-sm text-muted-foreground">No passes are on sale right now.</p>}
        {offers.map((o) => (
          <div
            key={o.plan}
            className={cn('flex items-center justify-between gap-3 rounded-lg border p-3', o.status === 'owned' && 'border-success/30 bg-success/5')}
          >
            <div className="min-w-0">
              <div className="font-medium">
                {planName(o.plan)} <span className="tabular text-muted-foreground">· {money(o.priceCents)}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {o.status === 'owned' ? `You have this through ${ymdText(o.end)}` : `Access through ${ymdText(o.end)}`}
              </div>
            </div>
            {o.status === 'available' && (
              <Button size="sm" variant="outline" onClick={onBuy} aria-label={`Buy ${planName(o.plan)}`}>
                Buy
              </Button>
            )}
          </div>
        ))}
        {!yearListed && <p className="text-xs text-muted-foreground">Year passes go on sale Apr 1 – Jun 30.</p>}
      </CardContent>
      {/* mt-auto: side by side with a taller card, keep the footer at the bottom */}
      <CardFooter className="mt-auto text-xs text-muted-foreground">
        {s.options.cardEnabled
          ? 'Card, Apple Pay and Google Pay through Stripe, or cash to an admin.'
          : 'Card payments aren’t set up yet. Pay cash to an admin.'}
      </CardFooter>
    </Card>
  );
}

const chartConfig = { sessions: { label: 'Sessions', color: 'var(--chart-1)' } } satisfies ChartConfig;

/** byMonth: check-ins per YYYY-MM for the last 6 months, counted by the server. */
function AttendanceChart({ byMonth, className }: { byMonth: Record<string, number>; className?: string }) {
  const data = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return {
        month: d.toLocaleDateString([], { month: 'short' }),
        sessions: byMonth[key] ?? 0,
      };
    });
  }, [byMonth]);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Attendance</CardTitle>
        <CardDescription>Check-ins per month, last 6 months</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="aspect-auto h-48 w-full">
          <BarChart data={data} margin={{ left: 0, right: 0, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
            <Bar dataKey="sessions" fill="var(--color-sessions)" radius={6} maxBarSize={36} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/**
 * The newest page of a history list comes with the account data (and refreshes
 * with it); "Show older" fetches the next page by cursor and keeps it.
 */
function useOlder(
  first: any[],
  firstCursor: string | null,
  idOf: (x: any) => string,
  fetchMore: (c: string) => Promise<{ items: any[]; nextCursor: string | null }>,
) {
  const [older, setOlder] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(firstCursor);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) setCursor(firstCursor);
  }, [firstCursor]);
  const all = useMemo(() => {
    const seen = new Set(first.map(idOf));
    return [...first, ...older.filter((x) => !seen.has(idOf(x)))];
  }, [first, older]); // eslint-disable-line react-hooks/exhaustive-deps
  async function more() {
    if (!cursor) return;
    setBusy(true);
    try {
      const r = await fetchMore(cursor);
      started.current = true;
      setOlder((o) => [...o, ...r.items]);
      setCursor(r.nextCursor);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return { all, hasMore: !!cursor, busy, more };
}

function ShowOlder({ h }: { h: { hasMore: boolean; busy: boolean; more: () => void } }) {
  if (!h.hasMore) return null;
  return (
    <div className="mt-3 flex justify-center">
      <Button variant="outline" size="sm" disabled={h.busy} onClick={h.more}>
        {h.busy && <Spinner />} Show older
      </Button>
    </div>
  );
}

function HistoryCard({
  checkins: firstCheckins,
  payments: firstPayments,
  checkinsCursor,
  paymentsCursor,
}: {
  checkins: any[];
  payments: any[];
  checkinsCursor: string | null;
  paymentsCursor: string | null;
}) {
  const c = useOlder(firstCheckins, checkinsCursor, (x) => x.at, async (cur) => {
    const r = await api.myCheckins(cur);
    return { items: r.checkins, nextCursor: r.nextCursor };
  });
  const p = useOlder(firstPayments, paymentsCursor, (x) => x.paymentId, async (cur) => {
    const r = await api.myPayments(cur);
    return { items: r.payments, nextCursor: r.nextCursor };
  });
  const checkins = c.all;
  const payments = p.all;
  return (
    <Card>
      <Tabs defaultValue="checkins">
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardAction>
            <TabsList>
              <TabsTrigger value="checkins">Check-ins</TabsTrigger>
              <TabsTrigger value="payments">Payments</TabsTrigger>
            </TabsList>
          </CardAction>
        </CardHeader>
        <CardContent className="pt-2">
          <TabsContent value="checkins">
            {checkins.length === 0 ? (
              <EmptyRow icon={CalendarCheck} text="No check-ins yet." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead className="text-right">Fee</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {checkins.map((c: any) => (
                    <TableRow key={c.at}>
                      <TableCell className="font-medium">{dateOf(c.at)}</TableCell>
                      <TableCell className="text-muted-foreground">{timeOf(c.at)}</TableCell>
                      <TableCell className="tabular text-right">
                        {c.coveredBy ? (
                          <Badge variant="secondary">{planName(c.coveredBy)}</Badge>
                        ) : c.freeDay ? (
                          <Badge className="bg-success/12 text-success">Free day</Badge>
                        ) : (
                          money(c.feeCents ?? 0)
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <ShowOlder h={c} />
          </TabsContent>
          <TabsContent value="payments">
            {payments.length === 0 ? (
              <EmptyRow icon={CreditCard} text="No payments yet." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>For</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p: any) => (
                    <TableRow key={p.paymentId}>
                      <TableCell className="font-medium">{dateOf(p.createdAt)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.plan ? planName(p.plan) : 'Credit'} · {p.method === 'cash' ? 'Cash' : p.method === 'card' ? 'Card' : p.method}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={p.status} />
                      </TableCell>
                      <TableCell className="tabular text-right">{money(p.amountCents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <ShowOlder h={p} />
          </TabsContent>
        </CardContent>
      </Tabs>
    </Card>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    confirmed: 'bg-success/12 text-success',
    pending: 'bg-brand/12 text-brand',
    denied: 'bg-destructive/10 text-destructive',
    expired: 'bg-muted text-muted-foreground',
  };
  return <Badge className={cn('capitalize', cls[status] ?? 'bg-muted text-muted-foreground')}>{status}</Badge>;
}

function EmptyRow({ icon: Icon, text }: { icon: any; text: string }) {
  return (
    <Empty className="py-8">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const pinSchema = z.object({ pin: z.string().regex(/^\d{4,6}$/, 'Use 4 to 6 digits') });

function PinCard() {
  const form = useForm<z.infer<typeof pinSchema>>({ resolver: zodResolver(pinSchema), defaultValues: { pin: '' } });
  const submit = form.handleSubmit(async (v) => {
    try {
      await api.setPin(v.pin);
      toast.success('PIN saved. Use it at the entrance kiosk.');
      form.reset();
    } catch (e: any) {
      toast.error(e.message);
    }
  });

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" /> Kiosk PIN
          </CardTitle>
          <CardDescription>The PIN you enter on the entrance kiosk after tapping your name.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-start">
          <div className="sm:w-56">
            <FormInput
              control={form.control}
              name="pin"
              label="New PIN"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              description="4 to 6 digits"
            />
          </div>
          <Button type="submit" className="sm:mt-[1.6rem]" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />} Save PIN
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
