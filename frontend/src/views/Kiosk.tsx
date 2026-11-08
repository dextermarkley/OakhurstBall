// Entrance kiosk (landscape-first, works in portrait).
//   Gym closed → "not open yet" (an admin opens the session from the Admin page).
//   Gym open   → who’s in + count, then tap name → PIN → check in ($5, once per session)
//     ├─ covered (pass) or balance ok → "You’re in", auto-reset
//     ├─ negative but within −$10    → "You’re in" + "you owe", pay now or later
//     └─ would go below −$10         → must pay first, then the kiosk checks them in
//                                      automatically once paid
// A red dot marks players with a negative balance (no amounts are shown).
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Banknote,
  CheckCircle2,
  Clock,
  CreditCard,
  Gift,
  Lock,
  Mail,
  QrCode,
  ScanLine,
  Search,
  Smartphone,
  Ticket,
  TriangleAlert,
  X,
} from 'lucide-react';
import { kiosk, type AgreementDoc, type CheckinResult, type Plan, type PlanOffer, type Session } from '@/api';
import { LogoMark } from '@/components/brand';
import { PinPad } from '@/components/pin-pad';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { balanceText, initials, money, planName, timeOf, ymdText } from '@/lib/format';
import { cn } from '@/lib/utils';
import { clearPairing, parsePairing, savePairing } from '@/pairing';
import { APP_VERSION, applyUpdate, useUpdateReady } from '@/pwa';
import { SignScreen } from './Agreements';
import { CashAmountPicker } from '@/components/cash-amount';

// Loaded only when the Scan button is tapped (keeps jsQR out of the main bundle).
const QrScanner = lazy(() => import('./QrScanner').then((m) => ({ default: m.QrScanner })));

/** If the page was opened from a pairing QR (Camera app), pair and scrub the URL. */
function pairFromUrl(): boolean {
  const p = parsePairing(window.location.hash);
  if (!p) return false;
  savePairing(p);
  history.replaceState(null, '', window.location.pathname); // drop the token from the address bar
  return true;
}

const PAIRING_ERRORS = new Set(['unknown kiosk', 'bad kiosk token', 'missing kiosk credentials']);

type Step = 'provision' | 'pick' | 'pin' | 'agree' | 'result' | 'pay' | 'cash' | 'card' | 'cashwait' | 'done';
/** What the player chose to pay for: drop-in credit (no plan) or a pass. */
type Purchase = { plan?: Plan; amountCents: number; what: string };
type PlayerLite = { playerId: string; name: string; negative: boolean };
type AttendeeLite = { playerId: string; name: string; at: string; negative: boolean };
type AdminLite = { adminId: string; name: string };

const IDLE_MS = 60_000;
const WAIT_MS = 10 * 60_000; // QR / cash confirmation wait
const POLL_MS = 3_000;
const DEFAULT_LIMIT_CENTS = 1000; // fallback if the server omits the owe-limit
const DEFAULT_FEE_CENTS = 500; // fallback if the server omits the session fee
const SESSION_POLL_MS = 15_000;

export function Kiosk() {
  const [justPaired] = useState(pairFromUrl);
  const provisioned = !!localStorage.getItem('kioskToken');
  const [step, setStep] = useState<Step>(provisioned ? 'pick' : 'provision');
  const [scanning, setScanning] = useState(false);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [attendees, setAttendees] = useState<AttendeeLite[]>([]);
  const [players, setPlayers] = useState<PlayerLite[]>([]);
  const [playersState, setPlayersState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [admins, setAdmins] = useState<AdminLite[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<PlayerLite | null>(null);
  const [pin, setPin] = useState('');
  const [checkin, setCheckin] = useState<CheckinResult | null>(null);
  const [card, setCard] = useState<{ paymentId: string; url: string; qr: string } | null>(null);
  const [cash, setCash] = useState<{ paymentId: string; adminName: string; emailed: boolean } | null>(null);
  const [buying, setBuying] = useState<Purchase | null>(null);
  const [inGym, setInGym] = useState(false); // checked in during this flow
  const [agreeDocs, setAgreeDocs] = useState<{ waiver: AgreementDoc; rules: AgreementDoc; changed: boolean } | null>(null);

  // Unattended kiosk: take a new version as soon as nobody is mid-check-in.
  const updateReady = useUpdateReady();
  useEffect(() => {
    if (updateReady && (step === 'pick' || step === 'provision')) applyUpdate();
  }, [updateReady, step]);
  const [done, setDone] = useState<{ title: string; detail: string; tone?: 'success' | 'info' } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (justPaired) toast.success('Kiosk paired');
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, [justPaired]);

  // A rejected pairing (token regenerated, device removed) → back to setup.
  const unpair = useCallback((why: string) => {
    clearPairing();
    setError(`This kiosk needs to be paired again (${why}).`);
    setStep('provision');
  }, []);

  /** Route any API failure: pairing problems send the kiosk back to setup; the rest show a readable message. */
  const fail = useCallback(
    (e: any) => {
      if (PAIRING_ERRORS.has(e?.message)) unpair(e.message);
      else setError(e?.message === 'wrong PIN' ? 'Wrong PIN. Try again.' : (e?.message ?? 'Something went wrong. Please try again.'));
    },
    [unpair],
  );

  const loadSession = useCallback(async () => {
    try {
      const r = await kiosk.session();
      setSession(r.session);
      setAttendees(r.attendees);
    } catch (e: any) {
      if (PAIRING_ERRORS.has(e.message)) unpair(e.message);
      else setError(e.message);
    }
  }, [unpair]);

  const onScan = useCallback((text: string) => {
    const p = parsePairing(text);
    if (!p) {
      setError("That QR code isn’t a kiosk pairing code.");
      return false; // keep scanning
    }
    savePairing(p);
    setScanning(false);
    setError('');
    toast.success('Kiosk paired');
    setStep('pick');
    return true;
  }, []);

  const reset = useCallback(() => {
    setSelected(null);
    setPin('');
    setCheckin(null);
    setCard(null);
    setCash(null);
    setBuying(null);
    setInGym(false);
    setDone(null);
    setError('');
    setFilter('');
    setBusy(false);
    setStep('pick');
  }, []);

  const loadPlayers = useCallback(() => {
    setPlayersState('loading');
    kiosk
      .players()
      .then((r) => {
        setPlayers(r.players);
        setPlayersState('ready');
      })
      .catch((e) => {
        setPlayersState('failed');
        if (PAIRING_ERRORS.has(e.message)) unpair(e.message);
      });
  }, [unpair]);

  // On the home screen: load names/admins, keep the session + roster fresh.
  useEffect(() => {
    if (step !== 'pick') return;
    loadSession();
    loadPlayers();
    kiosk.admins().then((r) => setAdmins(r.admins)).catch(() => {});
    const t = setInterval(loadSession, SESSION_POLL_MS);
    return () => clearInterval(t);
  }, [step, loadSession, loadPlayers]);

  // Idle reset.
  useEffect(() => {
    if (step === 'pick' || step === 'provision') return;
    // Reading and signing the waiver takes a while: give it 5 minutes of no touches.
    const ms = step === 'card' || step === 'cashwait' ? WAIT_MS : step === 'done' ? ((checkin?.balanceCents ?? 0) < 0 ? 15_000 : 10_000) : step === 'agree' ? 5 * 60_000 : IDLE_MS;
    const t = setTimeout(reset, ms);
    return () => clearTimeout(t);
  }, [step, tick, reset]);

  const checkedInIds = useMemo(() => new Set(attendees.map((a) => a.playerId)), [attendees]);
  const filtered = useMemo(
    () => players.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase())),
    [players, filter],
  );

  /** Show the outcome of a check-in attempt. */
  function handleCheckin(r: CheckinResult) {
    setCheckin(r);
    if (r.result === 'no_session') {
      setError("The gym isn’t open right now.");
      setStep('pick');
      return;
    }
    // Not checked in yet: ask how they want to pay (or, if allowed, pay next time).
    if (r.result === 'limit' || r.result === 'needs_payment') {
      setStep('result');
      return;
    }
    if (r.result !== 'checked_in' && r.result !== 'already') {
      // Never show "You’re in" for a reply this version doesn’t understand.
      setError("Couldn’t check you in. Please try again.");
      setStep('pick');
      return;
    }
    setInGym(true);
    const title = r.result === 'already' ? `You’re already in, ${first(r.name)}` : `You’re in, ${first(r.name)}!`;
    const bal = r.balanceCents ?? 0;
    setDone({
      title,
      detail: r.pass
        ? `Covered by your ${planName(r.pass.plan).toLowerCase()} through ${ymdText(r.pass.end)}.`
        : r.freeDay
          ? `It’s a free day, so there’s no charge today. Balance: ${balanceText(bal)}.`
          : r.result === 'already'
          ? `Balance: ${balanceText(bal)}`
          : bal < 0
            ? `Balance: ${balanceText(bal)}. You can owe up to ${money(r.limitCents ?? DEFAULT_LIMIT_CENTS)}; after that you can’t check in until you pay.`
            : `${money(r.feeCents ?? DEFAULT_FEE_CENTS)} from your credit · Balance: ${balanceText(bal)}`,
      tone: 'success',
    });
    setStep('done');
  }

  /** "Pay next time", or an allowed player who picked a payment method: check in now (balance may go negative). */
  async function checkInDeferred(): Promise<CheckinResult | null> {
    if (!selected) return null;
    const r = await kiosk.checkin(selected.playerId, pin, 'defer');
    if (r.result === 'checked_in' || r.result === 'already') setInGym(true);
    return r;
  }

  async function payNextTime() {
    setError('');
    setBusy(true);
    try {
      const r = await checkInDeferred();
      if (r) handleCheckin(r);
    } catch (e: any) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  /** Before starting a payment: allowed players are checked in right away so they never wait at the door. */
  async function checkInIfAllowed() {
    if (checkin?.result === 'needs_payment' && !inGym) await checkInDeferred();
  }

  async function submitPin(entered: string) {
    if (!selected) return;
    setError('');
    setBusy(true);
    try {
      const r = await kiosk.checkin(selected.playerId, entered);
      setPin(entered);
      if (r.result === 'needs_agreement') {
        // Sign the waiver + rules here first; check-in continues right after.
        setAgreeDocs({ ...(await kiosk.agreements()), changed: !!r.signedBefore });
        setStep('agree');
        return;
      }
      handleCheckin(r);
    } catch (e: any) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  /** After a confirmed payment: blocked players get checked in automatically. */
  async function afterPaid(s: { amountCents: number; balanceCents: number; plan: Plan | null; periodLabel: string | null }) {
    // Blocked players were waiting on this payment: check them in now.
    if (checkin?.result === 'limit' && !inGym && selected) {
      try {
        handleCheckin(await kiosk.checkin(selected.playerId, pin, 'defer'));
        return;
      } catch (e: any) {
        fail(e);
      }
    }
    setDone(
      s.plan
        ? {
            title: `${planName(s.plan)} active`,
            detail: s.periodLabel
              ? `Thanks, ${first(selected?.name ?? '')}! You’re covered for ${s.periodLabel}.`
              : `Thanks, ${first(selected?.name ?? '')}! Your pass is active.`,
            tone: 'success',
          }
        : {
            title: `${money(s.amountCents)} received`,
            detail: `Thanks, ${first(selected?.name ?? '')}! Balance: ${balanceText(s.balanceCents)}`,
            tone: 'success',
          },
    );
    setStep('done');
  }

  // Poll the pending payment (card QR or cash awaiting admin confirmation).
  const pendingId = step === 'card' ? card?.paymentId : step === 'cashwait' ? cash?.paymentId : undefined;
  useEffect(() => {
    if (!pendingId) return;
    let live = true;
    const t = setInterval(async () => {
      try {
        const s = await kiosk.paymentStatus(pendingId);
        if (!live) return;
        if (s.status === 'confirmed') {
          live = false;
          clearInterval(t);
          await afterPaid(s);
        } else if (s.status === 'expired' || s.status === 'denied') {
          live = false;
          clearInterval(t);
          setError(s.status === 'denied' ? 'The admin did not confirm that payment.' : 'That payment link expired.');
          setStep(backStep);
        }
      } catch {
        /* transient; keep polling */
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId]);

  async function startCard(p: Purchase) {
    if (!selected) return;
    setError('');
    setBuying(p);
    setBusy(true);
    try {
      await checkInIfAllowed();
      const r = await kiosk.payCard(selected.playerId, pin, p.plan);
      const qr = await QRCode.toDataURL(r.checkoutUrl, { width: 360, margin: 1, color: { dark: '#16213a' } });
      setCard({ paymentId: r.paymentId, url: r.checkoutUrl, qr });
      setStep('card');
    } catch (e: any) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function payCash(admin: AdminLite) {
    if (!selected) return;
    setError('');
    setBusy(true);
    try {
      await checkInIfAllowed();
      const r = await kiosk.payCash(selected.playerId, pin, admin.adminId, buying?.plan, buying?.amountCents);
      setCash({ paymentId: r.paymentId, adminName: r.adminName, emailed: r.emailed });
      setStep('cashwait');
    } catch (e: any) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const opts = checkin?.options;
  const backStep: Step = checkin?.result === 'limit' || checkin?.result === 'needs_payment' ? 'result' : 'pay';
  // Waiting screens: blocked players are checked in once the payment clears.
  const waitText = (what: 'paid' | 'confirmed') =>
    inGym
      ? `You’re checked in. We’re just waiting for ${what === 'paid' ? 'your payment to clear.' : 'the admin to confirm.'}`
      : `You’ll be checked in as soon as it’s ${what}.`;
  const chooseCash = (p: Purchase) => {
    setBuying(p);
    setError('');
    setStep('cash');
  };

  // ── Waiver + club rules, signed on the kiosk before the first check-in ──
  if (step === 'agree' && selected && agreeDocs) {
    return (
      <SignScreen
        waiver={agreeDocs.waiver}
        rules={agreeDocs.rules}
        changed={agreeDocs.changed}
        heading={`${first(selected.name)}, one quick thing before you play`}
        submit={(b) => kiosk.signAgreements(selected.playerId, pin, b)}
        onActivity={() => setTick((t) => t + 1)}
        onSigned={async () => {
          setAgreeDocs(null);
          setBusy(true);
          try {
            handleCheckin(await kiosk.checkin(selected.playerId, pin));
          } catch (e: any) {
            if (PAIRING_ERRORS.has(e.message)) unpair(e.message);
            else {
              setError(e.message);
              setStep('pick');
            }
          } finally {
            setBusy(false);
          }
        }}
        exit={{ label: 'Cancel', icon: <X />, onClick: reset }}
      />
    );
  }

  // ── One-time pairing of this kiosk ──
  if (step === 'provision') {
    return (
      <Screen>
        <div className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6 py-10">
          <div className="mb-8 flex items-center gap-3">
            <LogoMark className="size-10" />
            <div>
              <div className="font-semibold">Oakhurst Basketball</div>
              <div className="text-sm text-muted-foreground">Kiosk setup</div>
            </div>
          </div>
          {error && <ErrorAlert>{error}</ErrorAlert>}
          <Card>
            <CardContent>
              {scanning ? (
                <Suspense fallback={<div className="flex justify-center py-16"><Spinner className="size-6" /></div>}>
                  <QrScanner onResult={onScan} onCancel={() => setScanning(false)} />
                </Suspense>
              ) : (
                <>
                  <h1 className="text-xl font-semibold tracking-tight">Pair this kiosk</h1>
                  <p className="mt-2 text-sm text-muted-foreground">
                    On another device, open <span className="font-medium text-foreground">Admin → Kiosks → Pair a kiosk</span>, then
                    scan the QR code it shows.
                  </p>
                  <Button size="lg" className="mt-6 h-12 w-full text-base" onClick={() => { setError(''); setScanning(true); }}>
                    <ScanLine /> Scan pairing QR
                  </Button>
                  <ManualPair onPaired={() => { setError(''); setStep('pick'); }} />
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </Screen>
    );
  }

  const payChoices = opts && (
    <div className="space-y-3 text-left">
      {!opts.cardEnabled && (
        <p className="text-center text-sm text-muted-foreground">Card payments aren’t set up yet. Cash only for now.</p>
      )}
      {admins.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">Cash isn’t available right now. No admin is set up to receive it.</p>
      )}
      {step !== 'pay' && (
      <ChoiceRow
        icon={<Banknote className="size-5" />}
        title="Pay as you go"
        sub={`${money(checkin?.feeCents ?? DEFAULT_FEE_CENTS)} per session, from your balance`}
      >
        <Button
          size="lg"
          disabled={busy || !opts.cardEnabled}
          onClick={() => startCard({ amountCents: opts.cardCents, what: `${money(opts.cardCents)} account credit` })}
        >
          <CreditCard /> Card ({money(opts.cardCents)})
        </Button>
        <Button
          size="lg"
          variant="outline"
          disabled={busy || admins.length === 0}
          onClick={() => chooseCash({ amountCents: opts.cashCents, what: `${money(opts.cashCents)} account credit` })}
        >
          <Banknote /> Cash ({money(opts.cashCents)}+)
        </Button>
      </ChoiceRow>
      )}
      {opts.plans
        .filter((o) => o.status !== 'not_offered')
        .map((o: PlanOffer) => {
          const p: Purchase = { plan: o.plan, amountCents: o.priceCents, what: `${planName(o.plan)} · ${o.label}` };
          return (
            <ChoiceRow
              key={o.plan}
              icon={<Ticket className="size-5" />}
              title={o.status === 'owned' ? planName(o.plan) : `${planName(o.plan)} · ${money(o.priceCents)}`}
              sub={o.status === 'owned' ? `You have this (${o.label})` : `Access through ${ymdText(o.end)}`}
              owned={o.status === 'owned'}
            >
              {o.status === 'available' && (
                <>
                  <Button size="lg" disabled={busy || !opts.cardEnabled} onClick={() => startCard(p)}>
                    <CreditCard /> Card
                  </Button>
                  <Button size="lg" variant="outline" disabled={busy || admins.length === 0} onClick={() => chooseCash(p)}>
                    <Banknote /> Cash
                  </Button>
                </>
              )}
            </ChoiceRow>
          );
        })}
    </div>
  );

  return (
    <Screen onPointerDown={() => setTick((n) => n + 1)}>
      <div className="grid min-h-dvh lg:grid-cols-[minmax(320px,380px)_1fr]">
        {/* Left: status + who’s in (top band in portrait) */}
        <aside className="safe-top flex flex-col bg-primary px-6 py-6 text-primary-foreground lg:min-h-dvh lg:px-8 lg:py-8">
          <div className="flex items-center gap-3">
            <LogoMark className="size-10" />
            <div>
              <div className="font-semibold">Oakhurst Basketball</div>
              <div className="text-sm text-primary-foreground/60">
                {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
              </div>
            </div>
          </div>

          {session ? (
            <>
              <div className="mt-8 flex items-end justify-between lg:mt-12">
                <div>
                  <div className="text-sm font-medium text-primary-foreground/60">In the gym</div>
                  <div className="tabular text-6xl font-semibold tracking-tight">{attendees.length}</div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  {session.free && (
                    <div className="flex items-center gap-1.5 rounded-full bg-success px-3 py-1.5 text-sm font-medium text-white">
                      <Gift className="size-3.5" /> Free day
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm">
                    <Clock className="size-3.5" /> until {timeOf(session.closesAt)}
                  </div>
                </div>
              </div>
              <div className="mt-6 -mr-2 flex-1 overflow-y-auto pr-2 max-lg:max-h-36">
                {attendees.length === 0 ? (
                  <p className="text-sm text-primary-foreground/60">Nobody yet. Be the first!</p>
                ) : (
                  <ul className="flex flex-wrap gap-2 lg:flex-col lg:flex-nowrap lg:gap-1">
                    {attendees.map((a) => (
                      <li
                        key={a.playerId}
                        className="flex items-center gap-2.5 rounded-full bg-white/10 py-1 pr-3 pl-1 text-sm lg:rounded-lg lg:bg-transparent lg:px-1 lg:py-1.5"
                      >
                        <Avatar className="size-7 lg:size-8">
                          <AvatarFallback className="bg-white/15 text-[11px] text-primary-foreground">{initials(a.name)}</AvatarFallback>
                        </Avatar>
                        <span className="truncate">{a.name}</span>
                        {a.negative && <NegDot className="ml-auto" />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="mt-6 flex items-center gap-2 text-xs text-primary-foreground/50">
                <NegDot /> Balance below $0
                <span className="ml-auto">v{APP_VERSION}</span>
              </div>
            </>
          ) : (
            <div className="mt-8 text-sm text-primary-foreground/60 lg:mt-12">Check-in opens when an admin opens a session.</div>
          )}
        </aside>

        {/* Right: the interaction */}
        <section className="safe-bottom flex flex-col px-5 py-6 sm:px-8 lg:py-8">
          {error && <ErrorAlert>{error}</ErrorAlert>}

          {step === 'pick' && session === undefined && (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="size-7 text-muted-foreground" />
            </div>
          )}

          {step === 'pick' && session === null && (
            <Centered>
              <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-full bg-muted">
                <Lock className="size-7 text-muted-foreground" />
              </div>
              <h1 className="text-3xl font-semibold tracking-tight">The gym isn’t open right now</h1>
              <p className="mt-3 text-lg text-muted-foreground">Check-in opens when an admin opens a session.</p>
            </Centered>
          )}

          {step === 'pick' && session && (
            <>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Tap your name to check in</h1>
                <div className="relative sm:w-72">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="h-12 rounded-xl pl-10 text-base"
                    aria-label="Search players"
                  />
                </div>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {filtered.map((p) => {
                  const isIn = checkedInIds.has(p.playerId);
                  return (
                    <button
                      key={p.playerId}
                      onClick={() => {
                        setSelected(p);
                        setError('');
                        setStep('pin');
                      }}
                      className={cn(
                        'flex min-h-20 items-center gap-3 rounded-2xl border bg-card p-3 text-left shadow-xs transition active:scale-[0.98]',
                        'outline-none hover:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring/50',
                        isIn && 'bg-success/5',
                      )}
                    >
                      <Avatar className="size-11">
                        <AvatarFallback className={cn('text-sm font-medium', isIn && 'bg-success/15 text-success')}>
                          {isIn ? <CheckCircle2 className="size-5" /> : initials(p.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-base font-medium">{p.name}</span>
                          {p.negative && <NegDot />}
                        </div>
                        {isIn && <div className="text-xs font-medium text-success">Checked in</div>}
                      </div>
                    </button>
                  );
                })}
                {playersState === 'loading' && players.length === 0 && (
                  <div className="col-span-full flex justify-center py-10"><Spinner className="size-6 text-muted-foreground" /></div>
                )}
                {playersState === 'failed' && players.length === 0 && (
                  <div className="col-span-full py-10 text-center text-muted-foreground">
                    Couldn’t load players.
                    <div><Button variant="outline" className="mt-3" onClick={loadPlayers}>Retry</Button></div>
                  </div>
                )}
                {playersState === 'ready' && filtered.length === 0 && (
                  <p className="col-span-full py-10 text-center text-muted-foreground">
                    {filter.trim() ? `No players match "${filter.trim()}".` : 'No players found.'}
                  </p>
                )}
              </div>
            </>
          )}

          {step === 'pin' && selected && (
            <Centered>
              <BackButton onClick={reset} />
              <Avatar className="mx-auto size-16">
                <AvatarFallback className="bg-primary text-lg text-primary-foreground">{initials(selected.name)}</AvatarFallback>
              </Avatar>
              <h1 className="mt-4 text-2xl font-semibold tracking-tight">{selected.name}</h1>
              <p className="mt-1 mb-8 text-muted-foreground">Enter your PIN, then tap ✓</p>
              <PinPad onComplete={submitPin} disabled={busy} />
            </Centered>
          )}

          {step === 'result' && checkin && (
            <Centered wide>
              {checkin.result === 'limit' ? (
                <>
                  <IconBubble tone="danger"><TriangleAlert className="size-7" /></IconBubble>
                  <h1 className="text-2xl font-semibold tracking-tight">{first(checkin.name)}, please pay to check in</h1>
                  <p className="mt-2 text-muted-foreground">
                    Balance: <span className="font-medium text-destructive">{balanceText(checkin.balanceCents ?? 0)}</span>.
                    You can owe up to {money(checkin.limitCents ?? DEFAULT_LIMIT_CENTS)}. Pay at least {money(checkin.needCents ?? 0)} and
                    you’ll be checked in automatically.
                  </p>
                </>
              ) : (
                <>
                  <IconBubble tone="brand"><Banknote className="size-7" /></IconBubble>
                  <h1 className="text-2xl font-semibold tracking-tight">How do you want to pay, {first(checkin.name)}?</h1>
                  <p className="mt-2 text-muted-foreground">
                    Today is {money(checkin.feeCents ?? DEFAULT_FEE_CENTS)}. Balance:{' '}
                    <span className={cn('font-medium', (checkin.balanceCents ?? 0) < 0 && 'text-destructive')}>
                      {balanceText(checkin.balanceCents ?? 0)}
                    </span>
                    .
                  </p>
                </>
              )}
              <div className="mt-8">{payChoices}</div>
              {checkin.result === 'needs_payment' ? (
                <div className="mt-6 rounded-2xl border border-dashed p-4">
                  <Button variant="outline" size="lg" className="h-12 w-full text-base" disabled={busy} onClick={payNextTime}>
                    {busy && <Spinner />} Pay next time
                  </Button>
                  <p className="mt-3 text-sm text-muted-foreground">
                    Balance after today:{' '}
                    <span className="font-medium text-destructive">{balanceText(checkin.balanceAfterCents ?? 0)}</span>. You can
                    owe up to {money(checkin.limitCents ?? DEFAULT_LIMIT_CENTS)}; after that you can’t check in until you pay.
                  </p>
                </div>
              ) : null}
              <Button variant="ghost" size="lg" className="mt-4" onClick={reset}>
                Cancel
              </Button>
            </Centered>
          )}

          {step === 'pay' && checkin && (
            <Centered wide>
              <IconBubble tone="brand"><Ticket className="size-7" /></IconBubble>
              <h1 className="text-2xl font-semibold tracking-tight">Buy a pass, {first(checkin.name)}</h1>
              <p className="mt-2 text-muted-foreground">Check-ins are free for the rest of the period.</p>
              <div className="mt-8">{payChoices}</div>
              <Button variant="ghost" size="lg" className="mt-6" onClick={reset}>
                Not now
              </Button>
            </Centered>
          )}

          {step === 'cash' && buying && (
            <Centered wide>
              <BackButton onClick={() => setStep(backStep)} />
              <h1 className="text-2xl font-semibold tracking-tight">Who are you giving {money(buying.amountCents)} to?</h1>
              <p className="mt-2 text-muted-foreground">
                {buying.plan ? buying.what : 'Account credit. To pay more, change the amount in $5 steps.'}
              </p>
              {!buying.plan && (
                <div className="mt-6 rounded-2xl border bg-card py-5">
                  <CashAmountPicker
                    size="lg"
                    value={buying.amountCents}
                    disabled={busy}
                    onChange={(c) => setBuying({ ...buying, amountCents: c, what: `${money(c)} account credit` })}
                  />
                </div>
              )}
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {admins.map((a) => (
                  <button
                    key={a.adminId}
                    disabled={busy}
                    onClick={() => payCash(a)}
                    className="flex items-center gap-3 rounded-2xl border bg-card p-4 text-left shadow-xs transition outline-none hover:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.98] disabled:opacity-50"
                  >
                    <Avatar className="size-11">
                      <AvatarFallback>{initials(a.name)}</AvatarFallback>
                    </Avatar>
                    <span className="text-base font-medium">{a.name}</span>
                  </button>
                ))}
              </div>
            </Centered>
          )}

          {step === 'cashwait' && cash && buying && (
            <Centered>
              <IconBubble tone="brand">{cash.emailed ? <Mail className="size-7" /> : <Banknote className="size-7" />}</IconBubble>
              <h1 className="text-2xl font-semibold tracking-tight">
                Hand {money(buying.amountCents)} to {cash.adminName}
              </h1>
              <p className="mt-2 text-muted-foreground">{buying.what}</p>
              <p className="mt-6">
                {cash.emailed ? `${cash.adminName} got an email to confirm it.` : `${cash.adminName} can confirm it on the Admin page.`}
              </p>
              <p className="mt-2 inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                {waitText('confirmed')}
              </p>
              <div>
                <Button variant="ghost" size="lg" className="mt-8" onClick={reset}>
                  {inGym ? 'Done' : "Done, I’ll check in later"}
                </Button>
              </div>
            </Centered>
          )}

          {step === 'card' && card && buying && (
            <Centered>
              <BackButton onClick={() => setStep(backStep)} />
              <h1 className="text-2xl font-semibold tracking-tight">Pay {money(buying.amountCents)}</h1>
              <p className="mt-1 text-muted-foreground">{buying.what}</p>
              <div className="mx-auto mt-6 w-fit rounded-2xl border bg-white p-4 shadow-sm">
                <img src={card.qr} alt="Payment QR code" className="size-64 sm:size-72" />
              </div>
              <p className="mt-5 inline-flex items-center gap-2 font-medium">
                <Smartphone className="size-4" /> Scan with your phone · Apple Pay, Google Pay or card
              </p>
              <p className="mt-2 inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                {waitText('paid')}
              </p>
              <div>
                <Button variant="link" className="mt-4" render={<a href={card.url} />}>
                  <QrCode /> Pay on this kiosk instead
                </Button>
              </div>
            </Centered>
          )}

          {step === 'done' && done && (
            <Centered>
              <IconBubble tone={done.tone === 'success' ? 'success' : 'brand'} big>
                <CheckCircle2 className="size-10" />
              </IconBubble>
              <h1 className="text-3xl font-semibold tracking-tight">{done.title}</h1>
              <p className="mt-3 text-lg text-muted-foreground">{done.detail}</p>
              <div className="mt-8 flex flex-col items-center gap-2">
                <Button size="lg" className="h-12 min-w-40 text-base" onClick={reset}>
                  Done
                </Button>
                {checkin && !checkin.pass && !buying && checkin.options?.plans.some((o) => o.available) && (
                  <Button variant="ghost" onClick={() => setStep('pay')}>
                    <Ticket /> Buy a pass
                  </Button>
                )}
              </div>
            </Centered>
          )}
        </section>
      </div>
    </Screen>
  );
}

/* ── small presentational helpers ── */

const first = (name: string) => name.split(' ')[0] ?? name;

function Screen({ children, onPointerDown }: { children: ReactNode; onPointerDown?: () => void }) {
  return (
    <div className="min-h-dvh bg-background select-none" onPointerDown={onPointerDown}>
      {children}
    </div>
  );
}

function Centered({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-6">
      <div className={cn('relative w-full text-center', wide ? 'max-w-xl' : 'max-w-md')}>{children}</div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="mb-6 flex justify-start">
      <Button variant="ghost" size="lg" onClick={onClick}>
        <ArrowLeft /> Back
      </Button>
    </div>
  );
}

function IconBubble({ children, tone, big }: { children: ReactNode; tone: 'success' | 'danger' | 'brand'; big?: boolean }) {
  const cls = { success: 'bg-success/12 text-success', danger: 'bg-destructive/10 text-destructive', brand: 'bg-brand/12 text-brand' }[tone];
  return <div className={cn('mx-auto mb-5 flex items-center justify-center rounded-full', big ? 'size-20' : 'size-14', cls)}>{children}</div>;
}

function NegDot({ className }: { className?: string }) {
  return (
    <span className={cn('inline-block size-2.5 shrink-0 rounded-full bg-destructive ring-2 ring-destructive/20', className)} title="Balance below $0">
      <span className="sr-only">Balance below $0</span>
    </span>
  );
}

function ChoiceRow({
  icon,
  title,
  sub,
  owned,
  children,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  owned?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center', owned && 'border-success/30 bg-success/5')}>
      <div className="flex flex-1 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary">{icon}</div>
        <div className="min-w-0">
          <div className="font-medium">{title}</div>
          <div className="text-sm text-muted-foreground">{sub}</div>
        </div>
      </div>
      {children && <div className="flex gap-2 [&>button]:flex-1 sm:[&>button]:flex-none">{children}</div>}
    </div>
  );
}

function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="mb-5">
      <TriangleAlert />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function ManualPair({ onPaired }: { onPaired: () => void }) {
  const [deviceId, setDeviceId] = useState('');
  const [token, setToken] = useState('');
  return (
    <details className="mt-6 rounded-xl border p-4">
      <summary className="cursor-pointer text-sm text-muted-foreground">Enter the code by hand instead</summary>
      <div className="mt-4 space-y-3">
        <Input placeholder="Device ID, e.g. court-kiosk-1" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} aria-label="Device ID" />
        <Input placeholder="Token" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Token" />
        <Button
          variant="outline"
          className="w-full"
          disabled={!deviceId.trim() || !token.trim()}
          onClick={() => {
            savePairing({ deviceId: deviceId.trim(), token: token.trim() });
            onPaired();
          }}
        >
          Pair device
        </Button>
      </div>
    </details>
  );
}
