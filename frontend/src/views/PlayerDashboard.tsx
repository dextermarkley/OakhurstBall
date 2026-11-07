// The signed-in player's own page: gym session + check-in, plan, balance,
// attendance chart, kiosk PIN, and history. Also shown in Admin → "My player page".
import { useEffect, useMemo, useState } from 'react';
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
  KeyRound,
  Lock,
  Ticket,
  Users,
} from 'lucide-react';
import { api, type MySession, type Plan, type PlanOffer } from '@/api';
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
import { cn } from '@/lib/utils';

export function PlayerDashboard() {
  const [data, setData] = useState<any>(null);
  const [session, setSession] = useState<MySession | null>(null);
  const [error, setError] = useState('');

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
          <EmptyTitle>We couldn't load your account</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (!data || !session) return <DashboardSkeleton />;

  const firstName = String(data.name).split(' ')[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Hi, {firstName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Here's your Oakhurst Basketball account.</p>
      </div>

      <SessionCard s={session} onChange={load} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1">
        <StatCard
          label="Balance"
          icon={CircleDollarSign}
          tone={data.balanceCents < 0 ? 'danger' : 'success'}
          value={<span className={cn(data.balanceCents < 0 && 'text-destructive')}>{balanceText(data.balanceCents)}</span>}
          hint={data.balanceCents < 0 ? 'Owed to the club' : 'Covers pay-as-you-go sessions'}
        />
        <StatCard
          label="Plan"
          icon={Ticket}
          tone="brand"
          value={session.pass ? planName(session.pass.plan) : 'Pay as you go'}
          hint={session.pass ? `Through ${ymdText(session.pass.end)}` : `${money(session.feeCents)} per session`}
        />
        <StatCard
          label="Sessions attended"
          icon={CalendarCheck}
          value={data.checkins.length}
          hint={data.checkins[0] ? `Last: ${dateOf(data.checkins[0].at)}` : 'No check-ins yet'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <PlanCard s={session} className="lg:col-span-2" />
        <AttendanceChart checkins={data.checkins} className="lg:col-span-3" />
      </div>

      <HistoryCard checkins={data.checkins} payments={data.payments} />
      <PinCard />
    </div>
  );
}

function SessionCard({ s, onChange }: { s: MySession; onChange: () => void }) {
  const [busy, setBusy] = useState(false);

  async function checkIn() {
    setBusy(true);
    try {
      const r = await api.myCheckin();
      if (r.result === 'no_session') toast.error('The gym just closed.');
      else if (r.result === 'limit') toast.error(`Pay at least ${money(r.needCents ?? 0)} to check in.`);
      else if (r.result === 'already') toast.info("You're already checked in.");
      else toast.success(r.pass ? 'Checked in. Covered by your pass.' : `Checked in. ${money(r.feeCents ?? 0)} charged.`);
      onChange();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function addCredit() {
    setBusy(true);
    try {
      window.location.assign((await api.myPayCard()).checkoutUrl);
    } catch (e: any) {
      toast.error(e.message);
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
            <div className="text-lg font-semibold">The gym is open</div>
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
            <CheckCircle2 className="size-4" /> You're checked in
          </Badge>
        ) : s.canCheckIn ? (
          <Button size="lg" className="h-11 bg-brand px-5 text-base text-brand-foreground hover:bg-brand/90" disabled={busy} onClick={checkIn}>
            {busy && <Spinner />} {s.pass ? 'Check in · covered by pass' : `Check in · ${money(s.feeCents)}`}
          </Button>
        ) : (
          <div className="flex flex-col gap-2 sm:items-end">
            <div className="text-sm text-primary-foreground/80">
              Balance too low. Pay at least {money(s.needCents)} to check in.
            </div>
            <Button variant="secondary" disabled={busy || !s.options.cardEnabled} onClick={addCredit}>
              <CreditCard /> Add {money(s.options.cardCents)} credit
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlanCard({ s, className }: { s: MySession; className?: string }) {
  const [busy, setBusy] = useState<Plan | null>(null);
  const offers = s.options.plans.filter((o) => o.status !== 'not_offered');

  async function buy(o: PlanOffer) {
    setBusy(o.plan);
    try {
      window.location.assign((await api.myPayCard(o.plan)).checkoutUrl);
    } catch (e: any) {
      toast.error(e.message);
      setBusy(null);
    }
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Your plan</CardTitle>
        <CardDescription>
          {s.pass ? `${planName(s.pass.plan)} · ${s.pass.label}` : `Pay as you go · ${money(s.feeCents)} per session`}
        </CardDescription>
        {s.pass && (
          <CardAction>
            <Badge className="bg-success/12 text-success">Active</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
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
                {o.status === 'owned' ? `You have this through ${ymdText(o.end)}` : `Free check-ins through ${ymdText(o.end)}`}
              </div>
            </div>
            {o.status === 'available' && (
              <Button size="sm" variant="outline" disabled={!!busy || !s.options.cardEnabled} onClick={() => buy(o)}>
                {busy === o.plan && <Spinner />} Buy
              </Button>
            )}
          </div>
        ))}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        {s.options.cardEnabled
          ? 'Card, Apple Pay and Google Pay through Stripe. Cash at the kiosk.'
          : "Card payments aren't set up yet. Pay cash at the kiosk."}
      </CardFooter>
    </Card>
  );
}

const chartConfig = { sessions: { label: 'Sessions', color: 'var(--chart-1)' } } satisfies ChartConfig;

function AttendanceChart({ checkins, className }: { checkins: any[]; className?: string }) {
  const data = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return {
        month: d.toLocaleDateString([], { month: 'short' }),
        sessions: checkins.filter((c) => String(c.eventDate ?? c.at).startsWith(key)).length,
      };
    });
  }, [checkins]);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Attendance</CardTitle>
        <CardDescription>Sessions per month, last 6 months</CardDescription>
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

function HistoryCard({ checkins, payments }: { checkins: any[]; payments: any[] }) {
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
                  {checkins.map((c: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{dateOf(c.at)}</TableCell>
                      <TableCell className="text-muted-foreground">{timeOf(c.at)}</TableCell>
                      <TableCell className="tabular text-right">
                        {c.coveredBy ? <Badge variant="secondary">{planName(c.coveredBy)}</Badge> : money(c.feeCents ?? 0)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
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
                        {p.plan ? planName(p.plan) : 'Credit'} · {p.method}
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
      toast.success('PIN saved. Use it at the entrance iPad.');
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
          <CardDescription>The PIN you enter on the entrance iPad after tapping your name.</CardDescription>
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
