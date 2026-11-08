// Player-page payment popup, used two ways:
//   • at check-in (ask = the check-in reply): pay, or "pay next time" if allowed
//   • any time from "Pay now" (no ask)
// Card goes to Stripe Checkout; cash asks which admin gets the money, and that
// admin confirms by email (or on the Admin page), same as the kiosk.
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Banknote, CreditCard, Mail, Ticket } from 'lucide-react';
import { api, type CheckinResult, type MySession, type Plan } from '@/api';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { CashAmountPicker } from '@/components/cash-amount';
import { balanceText, initials, money, planName } from '@/lib/format';

type Purchase = { plan?: Plan; cents: number; label: string };
type Admin = { adminId: string; name: string };

export function PayDialog({
  open,
  onClose,
  s,
  ask,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  s: MySession;
  /** Set when opened from Check in (needs_payment or limit). */
  ask?: CheckinResult | null;
  /** Something changed (checked in, cash pending) — reload the page data. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [cashFor, setCashFor] = useState<Purchase | null>(null);
  // Cash credit can be more than $5 (in $5 steps); passes have a fixed price.
  const [cashCents, setCashCents] = useState(500);
  const chooseCash = (p: Purchase) => {
    setCashCents(p.cents);
    setCashFor(p);
  };
  const cashTotal = cashFor ? (cashFor.plan ? cashFor.cents : cashCents) : 0;
  const [sent, setSent] = useState<{ adminName: string; cents: number; emailed: boolean; label: string } | null>(null);
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open) {
      setCashFor(null);
      setSent(null);
      setBusy(false);
    } else if (!admins) {
      api.myAdmins().then((r) => setAdmins(r.admins)).catch(() => setAdmins([]));
    }
  }, [open, admins]);

  const canDefer = ask?.result === 'needs_payment';
  const blocked = ask?.result === 'limit';
  const creditCash: Purchase = { cents: s.options.cashCents, label: `${money(s.options.cashCents)} account credit` };
  const creditCard: Purchase = { cents: s.options.cardCents, label: `${money(s.options.cardCents)} account credit` };
  const passes: Purchase[] = s.options.plans
    .filter((o) => o.status === 'available')
    .map((o) => ({ plan: o.plan, cents: o.priceCents, label: `${planName(o.plan)} · ${o.label}` }));

  /** Allowed-to-defer players are checked in as soon as they choose to pay. */
  async function checkInFirst() {
    if (canDefer) await api.myCheckin('defer');
  }

  async function payCard(p: Purchase) {
    setBusy(true);
    try {
      await checkInFirst();
      const { checkoutUrl } = await api.myPayCard(p.plan);
      // Closed while waiting = changed their mind: don't whisk them off to Stripe.
      // (The unused checkout expires on its own; nothing is charged.)
      if (!openRef.current) return;
      window.location.assign(checkoutUrl);
      // If the browser hasn't left for Stripe after a while (blocked, slow, or
      // the player stayed), don't leave the options greyed out.
      setTimeout(() => setBusy(false), 15_000);
    } catch (e: any) {
      toast.error(e.message);
      setBusy(false);
    }
  }

  // Coming back from Stripe with the Back button (e.g. after a declined card)
  // restores this page exactly as it was left: still "busy", options greyed
  // out. Clear that and refresh the balance, since a payment may have gone through.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        setBusy(false);
        onChanged();
      }
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [onChanged]);

  async function payCash(admin: Admin) {
    if (!cashFor) return;
    setBusy(true);
    try {
      await checkInFirst();
      const r = await api.myPayCash(admin.adminId, cashFor.plan, cashFor.plan ? undefined : cashCents);
      const label = cashFor.plan ? cashFor.label : `${money(r.amountCents)} account credit`;
      // Closed while waiting? Say it in a toast rather than reopening to a stale screen.
      if (openRef.current) setSent({ adminName: r.adminName, cents: r.amountCents, emailed: r.emailed, label });
      else toast.success(`Hand ${money(r.amountCents)} to ${r.adminName}. Your balance updates when they confirm.`);
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function payNextTime() {
    setBusy(true);
    try {
      const r = await api.myCheckin('defer');
      if (r.result === 'checked_in' || r.result === 'already') toast.success(`Checked in. Balance ${balanceText(r.balanceCents ?? 0)}.`);
      else toast.error("Couldn't check you in. Refresh the page and try again.");
      onChanged();
      onClose();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const title = blocked ? 'Please pay to check in' : ask ? 'How do you want to pay?' : 'Pay now';
  const description = blocked
    ? `Your balance is ${balanceText(ask?.balanceCents ?? 0)}. Balances can go down to −${money(ask?.limitCents ?? 0)}, so pay at least ${money(ask?.needCents ?? 0)}.`
    : ask
      ? `Today is ${money(ask.feeCents ?? 0)}. Your balance is ${balanceText(ask.balanceCents ?? 0)}.`
      : `Your balance is ${balanceText(s.balanceCents)}.`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose() /* always closable: never trap someone in here */}>
      <DialogContent className="sm:max-w-md">
        {sent ? (
          <>
            <DialogHeader>
              <div className="mb-2 flex size-11 items-center justify-center rounded-full bg-brand/12 text-brand">
                <Mail className="size-5" />
              </div>
              <DialogTitle>
                Hand {money(sent.cents)} to {sent.adminName}
              </DialogTitle>
              <DialogDescription>
                {sent.label}.{' '}
                {sent.emailed ? `${sent.adminName} got an email to confirm it.` : `${sent.adminName} can confirm it on the Admin page.`}{' '}
                {blocked
                  ? 'Once they confirm, tap Check in again.'
                  : canDefer
                    ? "You're checked in. Your balance updates when they confirm."
                    : 'Your balance updates when they confirm.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : cashFor ? (
          <>
            <DialogHeader>
              <DialogTitle>Who are you giving {money(cashTotal)} to?</DialogTitle>
              <DialogDescription>
                {cashFor.plan ? cashFor.label : 'Account credit. Paying more? Change the amount in $5 steps.'}
              </DialogDescription>
            </DialogHeader>
            {!cashFor.plan && (
              <div className="rounded-lg border bg-muted/30 py-4">
                <CashAmountPicker value={cashCents} onChange={setCashCents} disabled={busy} />
              </div>
            )}
            <div className="grid gap-2 py-2">
              {admins === null && <Spinner className="mx-auto" />}
              {admins?.length === 0 && <p className="text-sm text-muted-foreground">No admins can take cash right now.</p>}
              {admins?.map((a) => (
                <Button key={a.adminId} variant="outline" className="h-12 justify-start gap-3" disabled={busy} onClick={() => payCash(a)}>
                  <Avatar className="size-7">
                    <AvatarFallback className="text-[11px]">{initials(a.name)}</AvatarFallback>
                  </Avatar>
                  {a.name}
                  {busy && <Spinner className="ml-auto" />}
                </Button>
              ))}
            </div>
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setCashFor(null)}>
                <ArrowLeft /> Back
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <Option
                icon={<Banknote className="size-4.5" />}
                title="Add credit"
                sub={`Pay as you go: ${money(s.feeCents || 500)} per session`}
              >
                <Button size="sm" disabled={busy || !s.options.cardEnabled} onClick={() => payCard(creditCard)}>
                  <CreditCard /> {money(creditCard.cents)}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => chooseCash(creditCash)}>
                  <Banknote /> Cash ({money(creditCash.cents)}+)
                </Button>
              </Option>
              {passes.map((p) => (
                <Option key={p.plan} icon={<Ticket className="size-4.5" />} title={`${planName(p.plan!)} · ${money(p.cents)}`} sub={p.label.split(' · ')[1] ?? ''}>
                  <Button size="sm" disabled={busy || !s.options.cardEnabled} onClick={() => payCard(p)}>
                    <CreditCard /> Card
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => chooseCash(p)}>
                    <Banknote /> Cash
                  </Button>
                </Option>
              ))}
              <p className="text-xs text-muted-foreground">
                {s.options.cardEnabled ? 'Card, Apple Pay or Google Pay through Stripe.' : "Card payments aren't set up yet."} Cash goes to
                an admin, who confirms it.
              </p>
            </div>
            {canDefer && (
              <div className="rounded-xl border border-dashed p-3">
                <Button variant="secondary" className="h-11 w-full" disabled={busy} onClick={payNextTime}>
                  {busy && <Spinner />} Pay next time
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  Your balance will be <span className="font-medium text-destructive">{balanceText(ask?.balanceAfterCents ?? 0)}</span>.
                  You can carry a balance of up to −{money(ask?.limitCents ?? 0)}; after that you can't check in until you pay.
                </p>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Option({ icon, title, sub, children }: { icon: React.ReactNode; title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center">
      <div className="flex flex-1 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">{icon}</div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{sub}</div>
        </div>
      </div>
      <div className="flex gap-2 [&>button]:flex-1 sm:[&>button]:flex-none">{children}</div>
    </div>
  );
}
