// Stripe Checkout returns here (usually on the player's own phone). The server
// re-reads the session from Stripe and credits the balance if it is paid.
// If this browser is the paired kiosk iPad, it goes back to check-in afterwards.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { stripeReturn } from '@/api';
import { LogoMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { money } from '@/lib/format';

export function Paid() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  const cancelled = params.has('cancelled');
  const isKiosk = !!localStorage.getItem('kioskToken');
  const [result, setResult] = useState<{ status: string; amountCents: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (sessionId) stripeReturn(sessionId).then(setResult).catch((e) => setError(e.message));
  }, [sessionId]);

  useEffect(() => {
    if (isKiosk && (cancelled || result || error)) {
      const t = setTimeout(() => window.location.assign('/kiosk'), 5000);
      return () => clearTimeout(t);
    }
  }, [isKiosk, cancelled, result, error]);

  let icon = <Spinner className="size-7" />;
  let tone = 'bg-muted text-muted-foreground';
  let title = 'Confirming your payment';
  let body = 'One moment…';
  if (cancelled) {
    icon = <XCircle className="size-7" />;
    title = 'Payment cancelled';
    body = 'No money was taken.';
  } else if (error) {
    icon = <XCircle className="size-7" />;
    tone = 'bg-destructive/10 text-destructive';
    title = "We couldn't confirm that payment";
    body = error;
  } else if (result?.status === 'confirmed') {
    icon = <CheckCircle2 className="size-7" />;
    tone = 'bg-success/12 text-success';
    title = `Paid ${money(result.amountCents)}`;
    body = "It's on your Oakhurst Basketball account. Have a good game!";
  } else if (result) {
    icon = <Clock className="size-7" />;
    tone = 'bg-brand/12 text-brand';
    title = 'Payment processing';
    body = 'Your account updates as soon as Stripe confirms it.';
  }

  return (
    <div className="safe-top flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-secondary/60 to-background px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <LogoMark className="size-9" />
        <span className="font-semibold">Oakhurst Basketball</span>
      </div>
      <Card className="w-full max-w-sm">
        <CardContent className="py-2 text-center">
          <div className={`mx-auto mb-4 flex size-14 items-center justify-center rounded-full ${tone}`}>{icon}</div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{body}</p>
          <Button className="mt-6 w-full" size="lg" render={<Link to={isKiosk ? '/kiosk' : '/player'} />}>
            {isKiosk ? 'Back to check-in' : 'Back to my account'}
          </Button>
          {isKiosk && <p className="mt-2 text-xs text-muted-foreground">Returning automatically…</p>}
        </CardContent>
      </Card>
    </div>
  );
}
