import { Link } from 'react-router-dom';
import { ArrowRight, CalendarCheck, CreditCard, ShieldCheck, UserRound } from 'lucide-react';
import { Logo } from '@/components/brand';
import { Card, CardContent } from '@/components/ui/card';

const entries = [
  {
    to: '/player',
    icon: UserRound,
    title: 'Player',
    body: 'Check in, see your balance and pass, and review your attendance.',
  },
  {
    to: '/admin',
    icon: ShieldCheck,
    title: 'Admin',
    body: 'Open sessions, manage players, confirm payments and set up kiosks.',
  },
];

export function Home() {
  return (
    <div className="min-h-dvh bg-background">
      <header className="safe-top mx-auto flex h-16 max-w-5xl items-center px-4 sm:px-6">
        <Logo />
      </header>

      <section className="mx-auto max-w-5xl px-4 pt-8 pb-12 sm:px-6 sm:pt-16">
        <div className="max-w-2xl">
          <p className="mb-3 inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-brand" /> Pickup basketball · Oakhurst
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Check in, pay, and play.
          </h1>
          <p className="mt-4 text-lg text-pretty text-muted-foreground">
            Drop in for $5, or grab a quarter pass and stop thinking about it.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {entries.map(({ to, icon: Icon, title, body }) => (
            <Link key={to} to={to} className="group rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <Card className="h-full transition group-hover:-translate-y-0.5 group-hover:shadow-md group-hover:ring-foreground/15">
                <CardContent className="flex h-full flex-col">
                  <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Icon className="size-5" />
                  </div>
                  <div className="flex items-center justify-between font-semibold">
                    {title}
                    <ArrowRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        <div className="mt-12 grid gap-6 border-t pt-10 sm:grid-cols-3">
          {[
            { icon: CalendarCheck, t: 'Pay as you go', d: '$5 per session, taken from your balance.' },
            { icon: CreditCard, t: 'Quarter pass', d: '$80 covers every session for the quarter.' },
            { icon: ShieldCheck, t: 'Year pass', d: '$320 for the full season, sold Apr 1 – Jun 30.' },
          ].map(({ icon: Icon, t, d }) => (
            <div key={t} className="flex gap-3">
              <Icon className="mt-0.5 size-5 shrink-0 text-brand" />
              <div>
                <div className="font-medium">{t}</div>
                <div className="text-sm text-muted-foreground">{d}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
