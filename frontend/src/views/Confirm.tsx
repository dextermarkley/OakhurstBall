// The one-tap confirm/deny page an admin lands on from a cash notification.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Banknote, CheckCircle2, CircleSlash, Clock, XCircle } from 'lucide-react';
import { confirm } from '@/api';
import { LogoMark } from '@/components/brand';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { dateOf, money, timeOf } from '@/lib/format';

export function ConfirmPage() {
  const { token = '' } = useParams();
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState<'confirm' | 'deny' | null>(null);

  useEffect(() => {
    confirm.get(token).then(setDetail).catch((e) => setError(e.message));
  }, [token]);

  async function act(action: 'confirm' | 'deny') {
    setBusy(action);
    setError('');
    try {
      setResult((await confirm.act(token, action)).result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const extra = detail?.note ? String(detail.note).split(' — ').slice(2).join(' — ') : '';
  const expired = /expire|invalid|not found|no longer|used/i.test(error);
  const finished = result || (detail && detail.status !== 'pending');

  return (
    <div className="safe-top flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-secondary/60 to-background px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <LogoMark className="size-9" />
        <span className="font-semibold">Oakhurst Basketball</span>
      </div>
      <Card className="w-full max-w-sm">
        <CardContent className="text-center">
          {error && !detail && (
            <Outcome icon={<Clock className="size-7" />} tone="muted" title={expired ? 'Link expired' : 'Couldn’t load this payment'} body={expired ? error : `${error} Check your connection and reload.`} />
          )}
          {!error && !detail && (
            <div className="space-y-3 py-4">
              <Skeleton className="mx-auto h-6 w-40" />
              <Skeleton className="mx-auto h-12 w-32" />
              <Skeleton className="mx-auto h-4 w-48" />
            </div>
          )}

          {detail && finished && (
            result === 'confirmed' ? (
              <Outcome icon={<CheckCircle2 className="size-7" />} tone="success" title="Payment confirmed" body="It’s been added to their account. You can close this page." />
            ) : result === 'denied' ? (
              <Outcome icon={<XCircle className="size-7" />} tone="danger" title="Payment denied" body="Nothing was credited. You can close this page." />
            ) : (
              <Outcome icon={<CircleSlash className="size-7" />} tone="muted" title="Already handled" body="This payment is no longer waiting for confirmation." />
            )
          )}

          {detail && !finished && (
            <>
              <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-brand/12 text-brand">
                <Banknote className="size-6" />
              </div>
              <p className="text-sm text-muted-foreground">Did you receive</p>
              <div className="tabular my-1 text-4xl font-semibold tracking-tight">{money(detail.amountCents)}</div>
              <p className="text-sm text-muted-foreground">
                {detail.method === 'card' ? 'by card' : 'in cash'} from{' '}
                <span className="font-medium text-foreground">{detail.playerName}</span>
              </p>
              {extra && <p className="mt-1 text-xs text-muted-foreground">{extra}</p>}
              <p className="mt-1 text-xs text-muted-foreground">
                {dateOf(detail.createdAt)} at {timeOf(detail.createdAt)}
              </p>
              {error && (
                <Alert variant="destructive" className="mt-4 text-left">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="mt-6 grid gap-2">
                <Button size="lg" className="h-11" disabled={!!busy} onClick={() => act('confirm')}>
                  {busy === 'confirm' ? <Spinner /> : <CheckCircle2 />} Yes, I received it
                </Button>
                <Button size="lg" variant="outline" className="h-11" disabled={!!busy} onClick={() => act('deny')}>
                  {busy === 'deny' && <Spinner />} No, I didn’t
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Outcome({ icon, tone, title, body }: { icon: React.ReactNode; tone: 'success' | 'danger' | 'muted'; title: string; body: string }) {
  const cls = { success: 'bg-success/12 text-success', danger: 'bg-destructive/10 text-destructive', muted: 'bg-muted text-muted-foreground' }[tone];
  return (
    <div className="py-2">
      <div className={`mx-auto mb-4 flex size-14 items-center justify-center rounded-full ${cls}`}>{icon}</div>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
